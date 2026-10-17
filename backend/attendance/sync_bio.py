import logging
import os
import sys
import json
import subprocess
import signal
import time
import filelock  # pip install filelock — cross-platform, works on Windows
from datetime import datetime
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor, as_completed

from zk import ZK
from anviz_sdk import AnvizConnectionError
from db.database import get_db_connection
from psycopg2.extras import execute_values

log = logging.getLogger(__name__)

SCANNER_CONNECT_TIMEOUT = 10      # ZK connect timeout (seconds)
ANVIZ_DLL_PATH          = None    # set to an absolute path if tc-b_new_sdk.dll isn't alongside anviz_sdk.py
ANVIZ_TOTAL_TIMEOUT     = 600    # hard ceiling for the whole worker subprocess (connect+download)
ANVIZ_WORKER_SCRIPT     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anviz_pull_worker.py")
MAX_WORKERS             = 6

# Device logs are deliberately read, never cleared.  The local unique key is
# the durable deduplication boundary, so a failed database write cannot cause
# a device punch to be lost on a later sync.
READ_ONLY_DEVICE_SYNC = True

# Legacy fallback for existing Anviz records that have not yet been assigned
# a per-device port. New scanners should always set backend.scanners.port.
# Keeping the fallback makes this migration non-disruptive for EMIS.
ANVIZ_PORT_MAP = {
    4: 5010,   # EMIS
}
ANVIZ_DEFAULT_PORT = 5010

# Prevents two invocations of sync_biometric_logs() from running concurrently.
# Without this, if a run takes close to ANVIZ_TOTAL_TIMEOUT and the scheduler
# fires again before it finishes, a second session against the same Anviz
# device can start while the first is still tearing down — which the device
# sees as a second client connecting mid-session (CONNECT_FAIL).
SYNC_LOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_biometric_logs.lock")

# Small JSON state file used purely for diagnostics: tracks the last time a
# run was skipped due to lock contention, and a per-scanner consecutive
# failure count. This lets failure logs say whether a given failure is
# plausibly related to a recent scheduler overlap (lock contention) or is
# more likely a persistent device-side issue (network flakiness, a stuck
# session left by CrossChex desktop software, firmware bug, etc).
#
# NOTE: this is local-disk, single-host state. If this job ever runs from
# multiple machines/containers, move this (and SYNC_LOCK_PATH) into the DB
# or a shared store like Redis — a local JSON file won't coordinate across
# hosts.
SYNC_STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_state.json")

# How long after a skipped (lock-contended) run we still treat a failure as
# "possibly related to that overlap" in the diagnostic log line.
LOCK_CONTENTION_WINDOW_SECONDS = 900  # 15 minutes

# Timing thresholds used to classify a failed connection attempt:
#   - "fast fail" (<= this many seconds): the device rejected the connection
#     almost immediately (e.g. CChex_ClientConnect returned -1 right away).
#     This usually means something else already holds the connection, a
#     stale session the device hasn't expired yet, or a config mismatch
#     (port/comm key) — the device is reachable and responsive, it's just
#     refusing this client.
#   - "near timeout" (>= ANVIZ_TOTAL_TIMEOUT minus this many seconds): the
#     worker ran (close to) the full timeout before we gave up on it. This
#     usually means the device (or network path) is hung/unresponsive
#     rather than actively refusing the connection.
#   - anything in between is reported as-is without a specific label.
FAST_FAIL_THRESHOLD_SECONDS   = 5
NEAR_TIMEOUT_MARGIN_SECONDS   = 15

# Mirrors AttendanceRecord's shape (user_id, timestamp, punch) so downstream
# code (_sync_one_scanner) doesn't need to know logs came from a subprocess.
_AnvizRecord = namedtuple("_AnvizRecord", ["user_id", "timestamp", "punch"])


def _load_state() -> dict:
    """Loads the diagnostic state file, tolerating a missing or corrupt file."""
    try:
        with open(SYNC_STATE_PATH, "r") as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}

    state.setdefault("last_lock_skip_ts", None)
    state.setdefault("scanner_failures", {})
    return state


def _save_state(state: dict):
    """Writes state atomically (write to temp file, then os.replace) so a
    crash mid-write can't corrupt sync_state.json for the next run."""
    tmp_path = SYNC_STATE_PATH + ".tmp"
    try:
        with open(tmp_path, "w") as f:
            json.dump(state, f)
        os.replace(tmp_path, SYNC_STATE_PATH)  # atomic on POSIX and Windows
    except OSError as e:
        log.warning(f"Failed to persist sync_state.json: {e}")


def _load_employee_map(cur) -> dict:
    """
    Returns { (emp_int, emp_no_str): emp_id }

    emp_int matches the integer `emp` column on the scanners table,
    so _match_employee can do a strict (agency, emp_no) lookup —
    preventing employees from one agency being matched against another
    agency's scanner.

    Also indexes every numeric emp_no under a leading-zero-normalized key
    (e.g. "007", "07", and "7" all resolve to the same employee) as long
    as that normalization doesn't collide with a DIFFERENT employee under
    the same agency once zeros are stripped. This is what actually
    absorbs "employee exists in employee_groupings, but the device's raw
    emp_no doesn't line up byte-for-byte with the spreadsheet's format" —
    by far the most common reason a punch stays stuck as UNKNOWN/RESIGNED
    even after the employee has been imported. The zero-pad-to-3 fallback
    in _match_employee is kept too, for non-digit / non-numeric formats
    this normalization doesn't touch.
    """
    cur.execute("""
        SELECT emp_no, emp_id, emp
        FROM frontend.employee_groupings
        WHERE emp_no IS NOT NULL
          AND emp_id IS NOT NULL
          AND emp    IS NOT NULL
    """)
    rows = cur.fetchall()

    employee_map = {}
    collided_norm_keys = set()

    for emp_no_raw, emp_id, emp in rows:
        emp_no = str(emp_no_raw).strip()
        employee_map[(emp, emp_no)] = emp_id

        if emp_no.isdigit():
            norm_key = (emp, str(int(emp_no)))  # strips leading zeros
            existing = employee_map.get(norm_key)
            if existing is not None and existing != emp_id:
                collided_norm_keys.add(norm_key)
            else:
                employee_map[norm_key] = emp_id

    # Two different employees in the same agency that normalize to the
    # same number (e.g. one genuinely IS "007" and another is "7") would
    # be ambiguous under the normalized key -- drop the shortcut for those
    # specific keys rather than silently picking one. Exact-format
    # matching for both employees still works untouched.
    for key in collided_norm_keys:
        employee_map.pop(key, None)
        log.warning(
            f"_load_employee_map: ambiguous leading-zero match for agency="
            f"{key[0]} emp_no~={key[1]} -- more than one employee shares "
            f"this number once leading zeros are stripped; skipping the "
            f"normalized-match shortcut for it."
        )

    return employee_map


def _load_scanners(cur) -> list:
    """
    Loads enabled scanners and their device-specific connection settings.
    `port` is nullable for legacy rows; protocol defaults are applied only
    when an older scanner has not been configured with a port yet.
    """
    cur.execute("""
        SELECT scanner_id, emp, ip_address, scanner_type, port
        FROM scanners
        WHERE is_enabled = TRUE
        ORDER BY scanner_id
    """)
    return cur.fetchall()


def _match_employee(employee_map: dict, scanner_emp, emp_no: str):
    """
    Strict (emp_int, emp_no) match, with two fallbacks for numeric
    emp_no's whose padding doesn't line up byte-for-byte with what's
    stored in employee_groupings:
      1. zero-padded to exactly 3 digits (legacy fallback, kept as-is)
      2. leading-zero-normalized (handled at lookup time via the
         normalized keys _load_employee_map() already indexes -- covers
         any padding width, not just 3 digits)
    Returns (emp_id | None, resolved_emp_no).
    """
    match = employee_map.get((scanner_emp, emp_no))
    if not match and emp_no.isdigit():
        padded = emp_no.zfill(3)
        match  = employee_map.get((scanner_emp, padded))
        if match:
            return match, padded

        normalized = str(int(emp_no))  # strips leading zeros, e.g. "007" -> "7"
        match = employee_map.get((scanner_emp, normalized))
        if match:
            return match, normalized
    return match, emp_no


def _backfill_unmatched_records(cur, employee_map: dict) -> int:
    """
    Re-checks punches already stored as 'UNKNOWN/RESIGNED' against the
    CURRENT employee_map and upgrades any that now match to 'ACTIVE'.

    Why this exists (a real gap in the normal sync flow, not a hypothetical):
      - _sync_one_scanner() only matches punches it just pulled fresh off a
        device -- it never re-examines rows already sitting in
        biometric_logs.
      - Each scanner's "last stored punch" watermark is MAX(punch_time)
        across ALL stored rows, matched or not -- so once a punch is
        stored (even as UNKNOWN), its timestamp is never re-requested from
        the device again.
      - The unique constraint's ON CONFLICT DO NOTHING means even a
        hypothetical re-insert of that same punch with correct data would
        just be silently discarded, not upgraded.

    Net effect without this function: if a punch arrives from a device
    BEFORE the corresponding employee exists in
    frontend.employee_groupings (e.g. an Excel import lands after that
    day's scheduled sync already ran), that specific punch is stuck as
    UNKNOWN permanently.

    Rows inserted before the emp-on-insert fix (see _sync_one_scanner) may
    still have `emp IS NULL` from the old behavior -- this joins back to
    `scanners` to recover it for re-matching those historical rows. New
    unmatched inserts carry `emp` (agency) directly and never need this.

    IMPORTANT -- this also resets `processed = FALSE` on every row it
    fixes. Without that, this function was silently incomplete: it healed
    biometric_logs (correct emp/emp_id/status), but attendance_processor's
    process_attendance() only ever pulls rows WHERE processed = FALSE. If
    a punch had already been through process_attendance() once (as
    UNKNOWN, before the Excel import landed), it was already marked
    processed = TRUE, so fixing it here would never get picked up again --
    attendance_logs would keep showing that day forever under the old
    "UNKNOWN_<emp_no>" placeholder, permanently out of sync with
    biometric_logs even though biometric_logs itself was correct. Resetting
    processed = FALSE makes the *next* process_attendance() run (scheduled
    right after this sync, or on demand) regenerate attendance_logs for
    these punches under the real emp_id.

    That in turn orphans the OLD attendance_logs row(s) sitting under the
    "UNKNOWN_<emp_no>" placeholder emp_id -- nothing will ever write to
    them again, since every biometric_logs row that fed them just got
    re-pointed at the real employee. Those placeholder rows are deleted
    below so the dashboard doesn't keep showing a duplicate "unknown
    employee" entry alongside the now-correctly-labeled one.

    Call this from _sync_biometric_logs_impl() on every scheduled run (so
    it self-heals over time), AND consider calling
    backfill_unmatched_employees() (below) directly from your web app right
    after an Excel import finishes, so new hires' earlier punches get
    fixed up immediately instead of waiting for the next scheduled run.
    """
    cur.execute("""
        SELECT DISTINCT bl.scanner_id, s.emp, bl.emp_no
        FROM biometric_logs bl
        JOIN scanners s ON s.scanner_id = bl.scanner_id
        WHERE bl.employee_status = 'UNKNOWN/RESIGNED'
    """)
    unmatched_rows = cur.fetchall()

    updated = 0
    stale_unknown_emp_ids = []  # placeholder emp_ids whose attendance_logs row is now orphaned
    still_unmatched = []        # (scanner_id, scanner_emp, emp_no) that failed to match this pass

    for scanner_id, scanner_emp, emp_no in unmatched_rows:
        match, resolved_emp_no = _match_employee(employee_map, scanner_emp, emp_no)
        if not match:
            still_unmatched.append((scanner_id, scanner_emp, emp_no))
            continue  # still not matchable -- leave as-is, not our problem to guess

        cur.execute("""
            UPDATE biometric_logs
            SET emp = %s,
                emp_id = %s,
                employee_status = 'ACTIVE',
                processed = FALSE
            WHERE scanner_id = %s
              AND emp_no = %s
              AND employee_status = 'UNKNOWN/RESIGNED'
        """, (scanner_emp, match, scanner_id, emp_no))

        if cur.rowcount:
            updated += cur.rowcount
            # Matches the f"UNKNOWN_{emp_no}" placeholder _sync_one_scanner
            # inserts biometric_logs.emp_id with -- see its ON CONFLICT
            # insert branch above.
            stale_unknown_emp_ids.append(f"UNKNOWN_{emp_no}")

    if stale_unknown_emp_ids:
        cur.execute("""
            DELETE FROM attendance_logs
            WHERE emp_id = ANY(%s)
        """, (stale_unknown_emp_ids,))

    # Always log a summary, even when nothing changed -- a silent 0 here
    # used to be indistinguishable from "nothing to do" vs "everything is
    # failing to match", which made this exact bug invisible in the logs.
    log.info(
        f"_backfill_unmatched_records: {len(unmatched_rows)} distinct "
        f"(scanner, emp_no) group(s) previously UNKNOWN/RESIGNED checked, "
        f"{updated} punch(es) upgraded to ACTIVE, "
        f"{len(still_unmatched)} still unmatched."
    )
    if still_unmatched:
        log.warning(
            f"_backfill_unmatched_records: still unmatched after this pass "
            f"(agency, emp_no)"
            f"If any of these employees ARE now in frontend.employee_groupings, "
            f"this is almost always a format mismatch between the device's raw "
            f"emp_no and the spreadsheet's emp_no column (e.g. a non-numeric "
            f"prefix, stray whitespace, or the wrong `emp` agency value) that "
            f"the numeric zero-padding fallbacks can't cover. Check with: "
            f"SELECT emp_no, emp_id, emp FROM frontend.employee_groupings "
            f"WHERE emp = <agency> -- and compare the exact stored emp_no "
            f"text against the values listed above, byte for byte."
        )

    return updated


def repair_stale_unknown_backfills(cur) -> int:
    """
    ONE-TIME repair for historical damage caused by the OLD version of
    _backfill_unmatched_records() (the one that upgraded
    UNKNOWN/RESIGNED -> ACTIVE but never reset `processed`).

    Why the regular self-healing path can't fix these on its own:
    _backfill_unmatched_records() only ever looks at rows still sitting at
    employee_status = 'UNKNOWN/RESIGNED'. Any row the OLD code already
    flipped to 'ACTIVE' before this fix was deployed is no longer
    'UNKNOWN/RESIGNED' -- it's invisible to that WHERE clause forever
    afterwards, even though it still has processed = TRUE and was never
    reprocessed into attendance_logs under the real emp_id.

    How affected rows are found: the OLD code fixed biometric_logs but
    never cleaned up the attendance_logs row it had earlier created under
    the "UNKNOWN_<emp_no>" placeholder emp_id (that cleanup is also new).
    That leftover placeholder row is the fingerprint -- it tells us
    exactly which emp_no values are still stuck with processed = TRUE in
    biometric_logs despite already being correctly matched. Use it to
    reset processed = FALSE on those rows, then delete the placeholder.

    Idempotent / safe to run more than once -- becomes a no-op as soon as
    there are no more "UNKNOWN_*" rows left in attendance_logs. Run this
    ONCE after deploying the processed-flag fix (e.g. from a one-off
    script or a console), then let the regular scheduled sync take over --
    you do not need to keep calling this on a schedule.
    """
    cur.execute("""
        SELECT DISTINCT emp_id FROM attendance_logs
        WHERE emp_id LIKE 'UNKNOWN\\_%' ESCAPE '\\'
    """)
    placeholder_emp_ids = [row[0] for row in cur.fetchall()]
    if not placeholder_emp_ids:
        return 0

    repaired = 0
    for placeholder in placeholder_emp_ids:
        emp_no = placeholder[len("UNKNOWN_"):]
        cur.execute("""
            UPDATE biometric_logs
            SET processed = FALSE
            WHERE emp_no = %s
              AND employee_status = 'ACTIVE'
              AND processed = TRUE
        """, (emp_no,))
        repaired += cur.rowcount

    cur.execute("""
        DELETE FROM attendance_logs
        WHERE emp_id = ANY(%s)
    """, (placeholder_emp_ids,))

    return repaired


def repair_stale_unknown_backfills_once():
    """
    Standalone entry point for repair_stale_unknown_backfills() -- run this
    ONE TIME after deploying the processed-flag fix, e.g.:

        python -c "from sync_bio import repair_stale_unknown_backfills_once as f; f()"

    or import and call it from a Python console / one-off admin script.
    Do not wire this into the scheduler -- it exists to clean up historical
    damage from before the fix, not as an ongoing job (the regular
    _backfill_unmatched_records(), already called on every scheduled sync,
    handles everything going forward).
    """
    db_conn = None
    try:
        db_conn = get_db_connection()
        cur = db_conn.cursor()
        repaired = repair_stale_unknown_backfills(cur)
        db_conn.commit()
        log.info(f"repair_stale_unknown_backfills_once: {repaired} row(s) reset to processed=FALSE for reprocessing.")
        print(f"Repaired {repaired} row(s). Run process_attendance() next to regenerate attendance_logs for them.")
        return repaired
    except Exception:
        if db_conn:
            db_conn.rollback()
        raise
    finally:
        if db_conn:
            db_conn.close()


def repair_null_emp_records(cur) -> int:
    """
    ONE-TIME repair for historical biometric_logs rows inserted before the
    emp-on-insert fix (see _sync_one_scanner), where unmatched punches were
    stored with `emp = NULL` instead of the scanner's known agency. That
    NULL propagates straight into attendance_logs.emp on the next process
    run, which is why some attendance_logs rows show a blank/NULL emp
    column even though the scanner it came from is known.

    Backfills `emp` from `scanners.emp` (the scanner a punch came from
    always implies its agency, match or no match) and resets
    processed = FALSE so process_attendance()'s next run regenerates the
    affected attendance_logs rows with the correct emp populated.

    Idempotent / safe to run more than once -- becomes a no-op once no
    biometric_logs row has emp IS NULL. Run this ONCE after deploying the
    emp-on-insert fix, the same way repair_stale_unknown_backfills_once()
    is run once after its corresponding fix.
    """
    cur.execute("""
        UPDATE biometric_logs bl
        SET emp = s.emp,
            processed = FALSE
        FROM scanners s
        WHERE bl.scanner_id = s.scanner_id
          AND bl.emp IS NULL
    """)
    return cur.rowcount


def repair_null_emp_records_once():
    """
    Standalone entry point for repair_null_emp_records() -- run this ONE
    TIME after deploying the emp-on-insert fix, e.g.:

        python -c "from sync_bio import repair_null_emp_records_once as f; f()"

    or import and call it from a Python console / one-off admin script.
    Do not wire this into the scheduler -- it exists to clean up historical
    damage from before the fix, not as an ongoing job (new unmatched
    inserts already carry `emp` correctly going forward).
    """
    db_conn = None
    try:
        db_conn = get_db_connection()
        cur = db_conn.cursor()
        repaired = repair_null_emp_records(cur)
        db_conn.commit()
        log.info(f"repair_null_emp_records_once: {repaired} row(s) backfilled and reset to processed=FALSE.")
        print(f"Repaired {repaired} row(s). Run process_attendance() next to regenerate attendance_logs for them.")
        return repaired
    except Exception:
        if db_conn:
            db_conn.rollback()
        raise
    finally:
        if db_conn:
            db_conn.close()


def backfill_unmatched_employees():
    """
    Standalone entry point, separate from the full device-pulling sync --
    only touches biometric_logs/employee_groupings, never talks to a
    scanner. Safe to call anytime, including while sync_biometric_logs()
    is mid-run (plain UPDATEs against biometric_logs -- Postgres MVCC
    handles this fine without needing SYNC_LOCK_PATH, since this never
    touches a device).

    Call this directly from your web app's Excel-import handler right
    after a successful import commits, e.g.:

        from sync_bio import backfill_unmatched_employees
        # ... after your import transaction commits ...
        backfill_unmatched_employees()

    This is what actually answers "how do newly imported employees get
    matched without waiting for the scheduler" -- rather than hoping the
    next scheduled run happens to catch them, the import step explicitly
    triggers the fix-up itself.
    """
    db_conn = None
    try:
        db_conn = get_db_connection()
        cur = db_conn.cursor()
        employee_map = _load_employee_map(cur)
        updated = _backfill_unmatched_records(cur, employee_map)
        db_conn.commit()
        log.info(f"backfill_unmatched_employees: {updated} previously-unmatched punch(es) upgraded to ACTIVE.")
        return updated
    except Exception:
        if db_conn:
            db_conn.rollback()
        raise
    finally:
        if db_conn:
            db_conn.close()


def _pull_zk_logs(ip_address: str, port: int = 4370):
    """Connects to a ZKTeco device and returns its raw attendance logs."""
    zk_conn = None
    zk = ZK(ip_address, port=port, timeout=SCANNER_CONNECT_TIMEOUT)
    try:
        zk_conn = zk.connect()
        return zk_conn.get_attendance()
    finally:
        if zk_conn:
            try:
                zk_conn.disconnect()
            except Exception:
                pass


def _pull_anviz_logs(ip_address: str, port: int):
    """
    Connects to an Anviz device and returns its raw attendance logs by
    running anviz_pull_worker.py as a CHILD PROCESS, not a thread.

    On timeout, we first send CTRL_BREAK_EVENT so the worker gets a chance
    to call sdk.disconnect() and log out of the device cleanly. Only if
    that grace period also expires do we fall back to a hard kill. This
    matters because a hard kill (TerminateProcess) gives the worker zero
    chance to run its own finally-block cleanup — which on some Anviz
    devices leaves the session "stuck" and causes CONNECT_FAIL on the
    next attempt.

    NOTE: CREATE_NEW_PROCESS_GROUP / CTRL_BREAK_EVENT are Windows-only.
    If this ever needs to run on Linux/macOS, guard this with
    `if os.name == "nt"` and fall back to process groups + SIGTERM/SIGKILL
    (start_new_session=True, then proc.terminate() / proc.kill()) there.
    """
    args = [sys.executable, ANVIZ_WORKER_SCRIPT, ip_address, str(port)]
    if ANVIZ_DLL_PATH:
        args.append(ANVIZ_DLL_PATH)

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    )

    try:
        stdout, stderr = proc.communicate(timeout=ANVIZ_TOTAL_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.send_signal(signal.CTRL_BREAK_EVENT)
        try:
            stdout, stderr = proc.communicate(timeout=8)
            grace_note = "worker caught CTRL_BREAK_EVENT and exited during the 8s grace period"
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            grace_note = "worker did not respond to CTRL_BREAK_EVENT within 8s — hard-killed"

        # stderr up to this point still holds every _trace() marker the worker
        # managed to emit before it was killed (see anviz_pull_worker.py's
        # _trace()). This is exactly what tells us WHERE inside the
        # connect/poll sequence things stalled — e.g. stuck after
        # "CCHex_ClientConnect — calling" with no matching "returned dev_idx=..."
        # line means the login handshake itself never completed, versus
        # stalling later inside the download poll loop after login succeeded.
        # Without this, a timeout error was previously just "did not respond
        # within 300s" with no trace attached, even though the worker's own
        # stderr had already captured exactly where it got stuck.
        trace_tail = (stderr or "").strip()
        trace_note = f" Worker trace:\n{trace_tail}" if trace_tail else " (worker produced no stderr output before being terminated)"

        raise AnvizConnectionError(
            f"Anviz device at {ip_address}:{port} did not respond within "
            f"{ANVIZ_TOTAL_TIMEOUT:.0f}s — worker process was terminated "
            f"({grace_note}).{trace_note}"
        )

    if proc.returncode != 0:
        stderr = stderr.strip() or f"worker exited with code {proc.returncode}"
        raise AnvizConnectionError(f"Anviz worker failed for {ip_address}:{port}: {stderr}")

    try:
        raw_records = json.loads(stdout)
    except json.JSONDecodeError as e:
        trace_tail = (stderr or "").strip()
        trace_note = f" Worker trace:\n{trace_tail}" if trace_tail else " (worker produced no stderr output)"
        raise AnvizConnectionError(
            f"Anviz worker for {ip_address}:{port} returned unparseable output "
            f"(exit code {proc.returncode}, stdout was {len(stdout)} char(s)): {e}.{trace_note}"
        )

    return [
        _AnvizRecord(
            user_id=r["user_id"],
            timestamp=datetime.fromisoformat(r["timestamp"]),
            punch=r["punch"],
        )
        for r in raw_records
    ]


def _sync_one_scanner(
    scanner_id: int,
    scanner_emp,
    ip_address: str,
    scanner_type: str,
    scanner_port,
    employee_map: dict,
) -> dict:
    result = {
        "scanner_id":       scanner_id,
        "scanner_type":     scanner_type,
        "inserted":         0,
        "unknown":          0,
        "skipped_old":      0,
        "missing":          set(),
        "error":            None,
        "pull_duration_s":  None,  # time spent in the connect/pull call, for fail-fast vs hung diagnostics
    }

    db_conn = None

    try:
        db_conn = get_db_connection()
        cur     = db_conn.cursor()

        cur.execute("""
            SELECT punch_time
            FROM biometric_logs
            WHERE scanner_id = %s
            ORDER BY punch_time DESC
            LIMIT 1
        """, (scanner_id,))
        last_row = cur.fetchone()
        last_punch_time = last_row[0] if last_row else None
        watermark_keys = set()
        if last_punch_time is not None:
            # Only the records at the watermark can still be candidates for
            # insertion. Loading this very small set avoids needless
            # ON-CONFLICT work when a scanner repeatedly returns its history.
            cur.execute("""
                SELECT emp_no, punch_type
                FROM biometric_logs
                WHERE scanner_id = %s AND punch_time = %s
            """, (scanner_id, last_punch_time))
            watermark_keys = {(str(emp_no), int(punch_type)) for emp_no, punch_type in cur.fetchall()}
        log.info(
            f"Scanner {scanner_id} ({scanner_type}, {ip_address}): "
            f"last stored punch = {last_punch_time}"
        )

        scanner_type_norm = (scanner_type or "").strip().lower()
        pull_start = time.monotonic()
        try:
            if scanner_type_norm in ("zk", "zkteco"):
                logs = _pull_zk_logs(ip_address, int(scanner_port or 4370))
            elif scanner_type_norm in ("anviz", "crosschex"):
                port = int(scanner_port or ANVIZ_PORT_MAP.get(scanner_emp, ANVIZ_DEFAULT_PORT))
                logs = _pull_anviz_logs(ip_address, port)
            else:
                raise ValueError(f"Unknown scanner_type '{scanner_type}' for scanner {scanner_id}")
        finally:
            # Recorded whether the pull succeeded, failed fast, or timed out —
            # _run_pool uses this to distinguish "device actively refused us"
            # from "device/network is hung" in its diagnostic log line.
            result["pull_duration_s"] = time.monotonic() - pull_start

        if not logs:
            log.info(f"Scanner {scanner_id}: no logs in device memory.")
            return result

        invalid_timestamp_count = sum(entry.timestamp is None for entry in logs)
        if invalid_timestamp_count:
            log.warning(
                f"Scanner {scanner_id}: ignoring {invalid_timestamp_count} record(s) without a timestamp."
            )
            logs = [entry for entry in logs if entry.timestamp is not None]
        if not logs:
            return result

        log.info(
            f"Scanner {scanner_id}: {len(logs)} log(s) in device memory | "
            f"earliest={min(l.timestamp for l in logs)} | "
            f"latest={max(l.timestamp for l in logs)} | "
            f"unique users={len(set(l.user_id for l in logs))}"
        )

        # A device can return a large history on every read. Keep only one
        # copy of each physical punch in this batch.  We intentionally retain
        # entries at the current watermark (`>=`): different punches may have
        # the same timestamp, and the database unique constraint cheaply
        # discards retries without losing a legitimate equal-time punch.
        records = []
        seen_punches = set()
        for entry in logs:
            if last_punch_time is not None and entry.timestamp < last_punch_time:
                result["skipped_old"] += 1
                continue

            emp_no = str(entry.user_id).strip() if entry.user_id else "UNKNOWN"
            punch_type = int(entry.punch)
            match, emp_no = _match_employee(employee_map, scanner_emp, emp_no)
            if entry.timestamp == last_punch_time and (emp_no, punch_type) in watermark_keys:
                result["skipped_old"] += 1
                continue

            punch_key = (emp_no, entry.timestamp, punch_type)
            if punch_key in seen_punches:
                continue
            seen_punches.add(punch_key)

            if not match:
                result["missing"].add(emp_no)
                # `emp` (agency) is stored even for unmatched punches --
                # scanner_emp is already known here, it's a parameter, not
                # something that depends on the employee match succeeding.
                # Previously this stored None/NULL, which meant every
                # UNKNOWN/RESIGNED row lost its agency until
                # _backfill_unmatched_records() re-derived it via a JOIN
                # back to scanners. Storing it directly here avoids ever
                # producing a NULL emp in the first place, and keeps
                # attendance_logs.emp populated even for punches that never
                # get matched to a real employee_id.
                records.append((
                    scanner_id, scanner_emp, emp_no, f"UNKNOWN_{emp_no}",
                    entry.timestamp, punch_type, "UNKNOWN/RESIGNED",
                ))
                continue

            records.append((
                scanner_id, scanner_emp, emp_no, match,
                entry.timestamp, punch_type, "ACTIVE",
            ))

        if not records:
            log.info(f"Scanner {scanner_id}: no new records to insert.")
            db_conn.commit()
            return result

        inserted_rows = execute_values(
            cur,
            """
            INSERT INTO biometric_logs
                (scanner_id, emp, emp_no, emp_id, punch_time, punch_type, employee_status)
            VALUES %s
            ON CONFLICT (scanner_id, emp_no, punch_time, punch_type) DO NOTHING
            RETURNING employee_status
            """,
            records,
            page_size=1000,
            fetch=True,
        )
        db_conn.commit()

        # Count rows actually written, not merely attempted: a watermark
        # retry at the same timestamp is expected to conflict harmlessly.
        result["inserted"] = sum(status == "ACTIVE" for (status,) in inserted_rows)
        result["unknown"]  = sum(status == "UNKNOWN/RESIGNED" for (status,) in inserted_rows)

        if result["missing"]:
            log.warning(
                f"Scanner {scanner_id} (emp={scanner_emp}): {len(result['missing'])} "
                f"unmatched emp_no(s) stored as UNKNOWN — {sorted(result['missing'])}. "
                f"If these are real active employees rather than resigned/unenrolled "
                f"staff, check SELECT emp_no, emp_id FROM frontend.employee_groupings "
                f"WHERE emp = {scanner_emp!r} AND emp_no IN (...) to see how their "
                f"emp_no is actually stored -- a mismatched format (e.g. padding, "
                f"leading zeros) is the most common cause."
            )

    except AnvizConnectionError as e:
        result["error"] = str(e)
        if db_conn:
            db_conn.rollback()

    except Exception as e:
        result["error"] = str(e)
        if db_conn:
            db_conn.rollback()

    finally:
        if db_conn:
            db_conn.close()

    return result


def _run_pool(scanners, employee_map, max_workers, results):
    """
    Submits _sync_one_scanner for a batch of scanners against a pool of the
    given size, logging each result as it completes.

    Also updates the diagnostic state (sync_state.json):
      - On failure, logs whether a scheduler overlap was skipped recently
        (suggesting the failure may be related to that overlap / a stuck
        session left behind by it) versus not (suggesting a persistent
        device-side issue), plus a running consecutive-failure count per
        scanner.
      - On success, resets that scanner's failure streak to 0.
    """
    state = _load_state()
    last_skip_ts = state.get("last_lock_skip_ts")

    recently_contended = False
    elapsed = None
    if last_skip_ts:
        try:
            elapsed = (datetime.now() - datetime.fromisoformat(last_skip_ts)).total_seconds()
            recently_contended = 0 <= elapsed < LOCK_CONTENTION_WINDOW_SECONDS
        except ValueError:
            pass  # malformed timestamp in state file — ignore, treat as no recent contention

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(
                _sync_one_scanner, scanner_id, scanner_emp, ip_address, scanner_type, scanner_port, employee_map
            ): scanner_id
            for scanner_id, scanner_emp, ip_address, scanner_type, scanner_port in scanners
        }

        for future in as_completed(futures):
            scanner_id = futures[future]
            try:
                r = future.result()
            except Exception as e:
                log.error(f"Scanner {scanner_id}: worker crashed — {e}")
                continue

            failures = state.setdefault("scanner_failures", {})
            key = str(scanner_id)

            if r["error"]:
                failures[key] = failures.get(key, 0) + 1

                if recently_contended:
                    overlap_note = (
                        f" a scheduler overlap was skipped ~{elapsed:.0f}s ago — this "
                        f"failure may be related to a stuck session from that overlap;"
                    )
                else:
                    overlap_note = " no recent scheduler overlap;"

                duration = r.get("pull_duration_s")
                if duration is None:
                    timing_note = " timing unavailable"
                elif duration <= FAST_FAIL_THRESHOLD_SECONDS:
                    timing_note = (
                        f" failed fast (~{duration:.1f}s) — the device actively refused/"
                        f"rejected the connection rather than hanging, which points to "
                        f"something already holding the session, a stale session the "
                        f"device hasn't expired yet, or a config mismatch (port/comm key), "
                        f"rather than a network/hang issue"
                    )
                elif duration >= (ANVIZ_TOTAL_TIMEOUT - NEAR_TIMEOUT_MARGIN_SECONDS):
                    timing_note = (
                        f" ran close to the full timeout (~{duration:.0f}s of "
                        f"{ANVIZ_TOTAL_TIMEOUT:.0f}s) before giving up — the device or "
                        f"network path is likely hung/unresponsive rather than actively "
                        f"refusing the connection"
                    )
                else:
                    timing_note = f" failed after ~{duration:.1f}s"

                log.error(
                    f"Scanner {scanner_id} ({r['scanner_type']}) failed: {r['error']} "
                    f"[{overlap_note}{timing_note}] (consecutive failures: {failures[key]})"
                )
                continue

            failures[key] = 0  # reset streak on success
            log.info(
                f"Scanner {scanner_id} ({r['scanner_type']}): "
                f"{r['inserted']} inserted, "
                f"{r['unknown']} unknown, "
                f"{r['skipped_old']} skipped (already stored)"
            )
            results.append(r)

    _save_state(state)


def _sync_biometric_logs_impl():
    """
    Pulls attendance from every scanner in `scanners` — ZKTeco and Anviz alike —
    in a single run, and writes them all into the same `biometric_logs` table.
    """
    start = time.monotonic()

    db_conn = None
    try:
        db_conn = get_db_connection()
        cur     = db_conn.cursor()

        employee_map = _load_employee_map(cur)
        log.info(f"Loaded {len(employee_map)} employee(s) from groupings")

        # Self-heals punches that got stuck as UNKNOWN/RESIGNED because the
        # employee didn't exist in employee_groupings yet at the time their
        # punch was first pulled (e.g. Excel import landed after a prior
        # scheduled run). See _backfill_unmatched_records()'s docstring for
        # why this can't be skipped -- the normal per-scanner sync below
        # never re-examines rows already stored in biometric_logs.
        backfilled = _backfill_unmatched_records(cur, employee_map)
        db_conn.commit()
        if backfilled:
            log.info(f"Backfill: {backfilled} previously-unmatched punch(es) upgraded to ACTIVE.")

        scanners = _load_scanners(cur)
        log.info(f"Found {len(scanners)} scanner(s) total")
    finally:
        if db_conn:
            db_conn.close()

    zk_scanners    = [s for s in scanners if (s[3] or "").strip().lower() in ("zk", "zkteco")]
    anviz_scanners = [s for s in scanners if (s[3] or "").strip().lower() in ("anviz", "crosschex")]
    other_scanners = [s for s in scanners if s not in zk_scanners and s not in anviz_scanners]

    results = []

    # ZK scanners: safe to run concurrently, as before.
    if zk_scanners:
        _run_pool(zk_scanners, employee_map, MAX_WORKERS, results)

    # Anviz scanners: run one at a time in a dedicated pool. Creating multiple
    # AnvizSDK() instances in the same process all load the same DLL — if the
    # DLL isn't written for true multi-instance reentrancy (likely, for this
    # kind of vendor SDK), concurrent sessions can collide on shared native
    # state and cause a call (commonly the CChex_Update poll loop) to block
    # forever. Serializing avoids that entirely; _pull_anviz_logs also enforces
    # a hard timeout so one unresponsive device can't stall the whole run.
    if anviz_scanners:
        _run_pool(anviz_scanners, employee_map, 1, results)

    # Any scanner_type we don't recognize still gets attempted (and will
    # correctly fail with "Unknown scanner_type") rather than silently dropped.
    if other_scanners:
        _run_pool(other_scanners, employee_map, MAX_WORKERS, results)

    total_inserted = sum(r["inserted"] for r in results)
    total_unknown  = sum(r["unknown"] for r in results)

    log.info(
        f"Sync complete — "
        f"{total_inserted} active record(s) inserted, "
        f"{total_unknown} unknown record(s) inserted. "
        f"Took {time.monotonic() - start:.1f}s."
    )


def sync_biometric_logs():
    """
    Entry point. Wraps _sync_biometric_logs_impl() in a non-blocking file lock
    so that if the scheduler fires again while a previous run is still in
    progress (e.g. a slow Anviz download approaching ANVIZ_TOTAL_TIMEOUT),
    the new invocation skips instead of starting a second, overlapping session
    against the same devices.

    When a run is skipped this way, the skip timestamp is recorded in
    sync_state.json so that _run_pool can flag any subsequent failure as
    possibly related to that overlap (see _run_pool's docstring).
    """
    lock = filelock.FileLock(SYNC_LOCK_PATH, timeout=0)
    try:
        with lock:
            _sync_biometric_logs_impl()
    except filelock.Timeout:
        state = _load_state()
        state["last_lock_skip_ts"] = datetime.now().isoformat()
        _save_state(state)
        log.warning("sync_biometric_logs: a previous run is still in progress — skipping this invocation.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sync_biometric_logs()