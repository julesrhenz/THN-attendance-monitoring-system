"""THN attendance: sequence inference with separate dated schedule evidence.

The production process_attendance path calls attendance.sequence_matcher.
Punch types 0/1 establish IN/OUT direction; unknown types use reviewed inference.
Raw chronological pairs are evaluated independently of the assigned shift;
schedule evidence is retained for display and does not control matching. Both scheduled_shift and
inferred_shift are persisted. Historical helper functions remain for regression
compatibility but are not the production grouping path.

Run from backend: python -m attendance.attendance_processor --init-schema
Then: python -m attendance.attendance_processor --rebuild
Reviewed attendance rows (manual_override=TRUE) and explicit punch confirmations
are preserved. See the project README_PUNCH_TYPE_MATCHING.md for deployment details.
"""

import json
import time as _time
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from bisect import bisect_right
from attendance.deletion_guard import ensure_deletion_schema
from attendance.sequence_matcher import infer_employee, summarize_day, VERSION as MATCHER_VERSION

from db.database import get_db_connection
from psycopg2.extras import execute_values


# Schema migrations belong on the startup path, not every scheduled batch.
# Keep this process-local flag so steady-state processing avoids DDL/catalog
# work while table_init.py provides the persistent schema setup.
_schema_ready = False
_PROCESS_ATTENDANCE_LOCK = 4815162342


# Matching uses local plant datetimes (the same timezone as scanner timestamps).
MAX_OVERTIME = timedelta(hours=5)
PUNCH_DEDUPE_WINDOW_SECONDS = 120


class _Lap:
    """Per-step timing for one processor tick, printed as [attendance-timing].
    The advisory lock is held for the whole tick, so this also shows how long
    imports/manual moves had to wait."""
    def __init__(self):
        self.t0 = self.last = _time.perf_counter()
        self.steps = []

    def mark(self, name):
        now = _time.perf_counter()
        self.steps.append((name, now - self.last))
        self.last = now

    def report(self, note="", min_total=0.0):
        total = _time.perf_counter() - self.t0
        if total < min_total:
            return
        print(f"[attendance-timing] {note} total={total:.1f}s | "
              + " | ".join(f"{n}={d:.1f}s" for n, d in self.steps), flush=True)


def shift_bounds(work_date, shift):
    start = datetime.combine(work_date, shift["start_time"])
    end = datetime.combine(work_date, shift["end_time"])
    if end <= start:
        end += timedelta(days=1)
    return start, end


def schedule_at(events, scheduled_start):
    """Latest effective event at shift start; equal-time conflicts are unknown.

    Events: sorted (effective_at, priority, source_id, shift_name). Manual moves
    have higher tie priority than batches. Same-time different shifts require
    review rather than silently selecting one of two conflicting Excel files.
    """
    index = bisect_right([e[0] for e in events], scheduled_start) - 1
    if index < 0:
        return None
    effective_at = events[index][0]
    same_time = [e for e in events if e[0] == effective_at]
    priority = max(e[1] for e in same_time)
    names = {(e[3] or "").strip().casefold() for e in same_time if e[1] == priority}
    return names.pop() if len(names) == 1 else None


def match_scheduled_punch(punch, events, shifts, day_overrides=None):
    """Match dated occurrences; transitions may produce overlapping windows.

    Each occurrence uses its own recurring cutoff as an inference window.
    Zero/multiple candidates become review items, never an arbitrary match.
    Unlimited early scans are retained even when outside all inference windows.
    """
    candidates = []
    for offset in (-1, 0, 1):
        work_date = punch.date() + timedelta(days=offset)
        for name, shift in shifts.items():
            start, end = shift_bounds(work_date, shift)
            if (day_overrides or {}).get(work_date, schedule_at(events, start)) != name:
                continue
            if end - timedelta(days=1) + MAX_OVERTIME < punch <= end + MAX_OVERTIME:
                candidates.append((work_date, shift))
    if len(candidates) == 1:
        return candidates, None
    if candidates:
        return candidates, "OVERLAPPING_SHIFT_ASSIGNMENTS"
    known = any(schedule_at(events, datetime.combine(punch.date() + timedelta(days=offset), shift["start_time"])) in shifts
                for offset in (-1, 0, 1) for shift in shifts.values())
    return [], "OUTSIDE_SCHEDULE_WINDOW" if known else "HISTORICAL_SCHEDULE_MISSING"


def load_schedule_history(cur, employee_ids):
    # A scheduled batch is evidence of the intended schedule even before the
    # dashboard applies it to the live roster. Future events only affect future
    # shift starts, so overnight shifts already in progress retain their shift.
    cur.execute("""
        SELECT s.emp_id, COALESCE(b.schedule_effective_at, b.effective_at), 0 AS priority, b.id, s.shift
        FROM frontend.employee_snapshot_records s
        JOIN frontend.import_batches b ON b.id = s.batch_id
        WHERE s.emp_id = ANY(%s) AND COALESCE(b.schedule_effective_at, b.effective_at) IS NOT NULL
        UNION ALL
        SELECT m.emp_id, m.detected_at, 1 AS priority, m.id, m.new_value
        FROM frontend.employee_movements m
        WHERE m.emp_id = ANY(%s) AND m.field_name = 'SHIFT'
          AND m.to_batch_id IS NULL AND m.detected_at IS NOT NULL
        ORDER BY 1, 2, 3, 4
    """, (employee_ids, employee_ids))
    history = defaultdict(list)
    for emp_id, stamp, priority, source_id, name in cur.fetchall():
        if stamp.tzinfo is not None:
            stamp = stamp.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None)
        history[emp_id].append((stamp, priority, source_id, name))
    return history


def ensure_matching_schema(cur):
    cur.execute("ALTER TABLE frontend.import_batches ADD COLUMN IF NOT EXISTS schedule_effective_at TIMESTAMP")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_schedule_snapshot_emp_batch ON frontend.employee_snapshot_records (emp_id, batch_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_schedule_movement_emp_time ON frontend.employee_movements (emp_id, detected_at) WHERE field_name = 'SHIFT'")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS frontend.attendance_schedule_corrections (
            emp_id VARCHAR(50) NOT NULL, work_date DATE NOT NULL,
            shift_name VARCHAR(50) NOT NULL, reason TEXT NOT NULL,
            confirmed_by TEXT NOT NULL, confirmed_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
            PRIMARY KEY (emp_id, work_date)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS frontend.attendance_punch_assignments (
            emp_id VARCHAR(50) NOT NULL, punch_time TIMESTAMP NOT NULL,
            work_date DATE NOT NULL, shift_name VARCHAR(50) NOT NULL,
            role VARCHAR(3) NOT NULL CHECK (role IN ('IN','OUT')),
            reason TEXT NOT NULL, confirmed_by TEXT NOT NULL,
            confirmed_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
            PRIMARY KEY (emp_id, punch_time)
        )
    """)


def load_confirmations(cur, employee_ids):
    cur.execute("SELECT emp_id, work_date, shift_name FROM frontend.attendance_schedule_corrections WHERE emp_id = ANY(%s)", (employee_ids,))
    dates = defaultdict(dict)
    for emp_id, work_date, name in cur.fetchall():
        dates[emp_id][work_date] = name.strip().casefold()
    cur.execute("SELECT emp_id, punch_time, work_date, shift_name, role FROM frontend.attendance_punch_assignments WHERE emp_id = ANY(%s)", (employee_ids,))
    assignments = {(r[0], r[1]): (r[2], r[3].strip().casefold(), r[4]) for r in cur.fetchall()}
    return dates, assignments


def suggest_overlap(punch, candidates):
    """Tentative ownership only; never certifies direction from timestamps.

    Require proximity within two hours and a one-hour advantage over the
    alternative. These are confidence thresholds, not early-arrival limits.
    """
    ranked = []
    for work_date, shift in candidates:
        start, end = shift_bounds(work_date, shift)
        ds, de = abs(punch - start), abs(punch - end)
        ranked.append((min(ds, de), work_date, shift, 'IN' if ds < de else 'OUT'))
    ranked.sort(key=lambda x: x[0])
    if len(ranked) < 2:
        return None
    best, runner = ranked[:2]
    if best[0] <= timedelta(hours=2) and runner[0] - best[0] >= timedelta(hours=1):
        return (best[1], best[2]), best[3]
    return None


def review_endpoints(tin, tout, status, reason, problems):
    if problems:
        # Unassigned punches are excluded before endpoint selection. Their
        # presence must not erase other usable endpoints or confirmations.
        if 'CONFLICTING_SHIFT_EVIDENCE' in problems:
            tin = tout = None
        status = 'NEEDS_REVIEW'
        reason = ';'.join(sorted(set(filter(None, (reason or '').split(';'))) | problems))
    return tin, tout, status, reason


def match_with_confirmation(punch, events, shifts, dates, assignment):
    if assignment is None:
        candidates, problem = match_scheduled_punch(punch, events, shifts, dates)
        return candidates, problem, None
    work_date, name, role = assignment
    if name not in shifts or role not in ('IN', 'OUT'):
        return [], 'INVALID_CONFIRMED_ASSIGNMENT', None
    return [(work_date, shifts[name])], None, role


def apply_confirmed_roles(tin, tout, status, reason, punches, roles, now, work_date, shift):
    if not roles:
        return tin, tout, status, reason
    ins = [p for p in punches if roles.get(p[0]) == 'IN']
    outs = [p for p in punches if roles.get(p[0]) == 'OUT']
    if len(ins) > 1 or len(outs) > 1:
        return None, None, 'NEEDS_REVIEW', 'CONFLICTING_CONFIRMED_ENDPOINTS'
    if tin and roles.get(tin[0]) == 'OUT': tin = None
    if tout and roles.get(tout[0]) == 'IN': tout = None
    tin = ins[0] if ins else tin
    tout = outs[0] if outs else tout
    if tin and tout and tin[0] >= tout[0]:
        return None, None, 'NEEDS_REVIEW', 'INVALID_CONFIRMED_ORDER'
    # A confirmation resolves ownership and direction of that punch only.
    if len(punches) > 2:
        return tin, tout, 'NEEDS_REVIEW', 'EXTRA_PUNCHES'
    if tin and tout:
        return tin, tout, ('PROVISIONAL' if now <= shift_bounds(work_date, shift)[1] + MAX_OVERTIME else 'MATCHED'), None
    if tin:
        return tin, None, ('PROVISIONAL' if now <= shift_bounds(work_date, shift)[1] + MAX_OVERTIME else 'NEEDS_REVIEW'), 'MISSING_OUT'
    return None, tout, 'NEEDS_REVIEW', 'MISSING_IN'


def _dedupe_punches(rows, assignments=None):
    """Suppress repeat taps within 120s of the first retained tap; keep raw rows."""
    assignments = assignments or {}
    result = []
    last = {}
    for row in rows:
        emp, stamp = row[3], row[5]
        if emp in last and (stamp - last[emp]).total_seconds() <= PUNCH_DEDUPE_WINDOW_SECONDS:
            previous = result[-1]
            old_assignment = assignments.get((emp, previous[5]))
            new_assignment = assignments.get((emp, stamp))
            if old_assignment and new_assignment and old_assignment != new_assignment:
                result.append(row)  # Preserve conflicting confirmations for review.
                last[emp] = stamp
            elif new_assignment and not old_assignment:
                result[-1] = row
                last[emp] = stamp
            continue
        result.append(row)
        last[emp] = stamp
    return result


def resolve_shift_punches(punches, work_date, shift, now):
    """Return inferred endpoints and review information, never use punch_type.

    More than two distinct events or endpoints on the same side of the shift
    midpoint are ambiguous. Candidate endpoints are retained for review rather
    than presented as a verified pair. Single punches use nearest endpoint only
    as a suggestion and always need review once the matching window closes.
    """
    punches = sorted(punches)
    reasons = []
    if shift is None:
        return None, None, "NEEDS_REVIEW", "MISSING_SHIFT_ASSIGNMENT"
    start, end = shift_bounds(work_date, shift)
    midpoint = start + (end - start) / 2
    tin = tout = None
    if len(punches) == 1:
        if punches[0][0] < midpoint:
            tin = punches[0]
            reasons.append("MISSING_OUT")
        else:
            tout = punches[0]
            reasons.append("MISSING_IN_OR_LATE_ARRIVAL")
    elif punches:
        if punches[0][0] < midpoint <= punches[-1][0]:
            tin, tout = punches[0], punches[-1]
        else:
            reasons.append("AMBIGUOUS_ENDPOINTS")
        if len(punches) > 2:
            reasons.append("EXTRA_PUNCHES")
    for stamp, _ in punches:
        if stamp < start and abs(stamp - (end - timedelta(days=1))) <= abs(stamp - start):
            reasons.append("EARLY_ARRIVAL_OR_PREVIOUS_LATE_OUT")
    if now <= end + MAX_OVERTIME:
        status = "NEEDS_REVIEW" if any(r != "MISSING_OUT" for r in reasons) else "PROVISIONAL"
    else:
        status = "NEEDS_REVIEW" if reasons else "MATCHED"
    return tin, tout, status, ";".join(sorted(set(reasons))) or None


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------
def ensure_attendance_columns(cur):
    ensure_deletion_schema(cur)
    columns = [
        ("emp_id",            "VARCHAR(30)"),
        ("shift_name",        "VARCHAR(50)"),
        ("time_in_status",    "VARCHAR(20)"),
        ("time_out_status",   "VARCHAR(20)"),
        ("time_in_location",  "VARCHAR(100)"),
        ("time_out_location", "VARCHAR(100)"),
        ("emp_status",        "VARCHAR(20)"),
        ("full_name",         "TEXT"),
        ("attendance_date",   "DATE"),
        ("time_in",           "TIME"),
        ("time_out",          "TIME"),
        ("time_in_at", "TIMESTAMP"),
        ("time_out_at", "TIMESTAMP"),
        ("matching_status", "VARCHAR(30)"),
        ("review_reason", "TEXT"),
        ("source_punches", "JSONB"),
        ("manual_override", "BOOLEAN NOT NULL DEFAULT FALSE"),
        ("scheduled_shift", "VARCHAR(50)"),
        ("inferred_shift", "VARCHAR(50)"),
        ("matching_method", "VARCHAR(30)"),
        ("sequence_margin", "DOUBLE PRECISION"),
    ]
    cur.execute("CREATE INDEX IF NOT EXISTS idx_biometric_emp_time ON backend.biometric_logs (emp_id, punch_time)")
    # Widen existing columns when their limits are below our definitions.
    # ADD COLUMN IF NOT EXISTS does not update existing column widths.
    for col_name, col_def in columns:
        if not (col_def.startswith("VARCHAR(") or col_def == "TEXT"):
            continue

        required_width = (
            int(col_def[8:-1])
            if col_def.startswith("VARCHAR(")
            else None
        )

        cur.execute("""
            SELECT data_type, character_maximum_length
            FROM information_schema.columns
            WHERE table_schema = 'backend'
              AND table_name = 'attendance_logs'
              AND column_name = %s
        """, (col_name,))

        existing = cur.fetchone()

        if not existing:
            continue

        data_type, current_width = existing

        if data_type not in ("character varying", "character"):
            continue

        needs_widening = (
            required_width is None
            or (
                current_width is not None
                and current_width < required_width
            )
        )

        if needs_widening:
            # Column names and definitions come from the fixed columns list.
            cur.execute(
                f"ALTER TABLE backend.attendance_logs "
                f"ALTER COLUMN {col_name} TYPE {col_def}"
            )

    for col in ("time_in", "time_out"):
        cur.execute(f"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name  = 'attendance_logs'
                      AND column_name = '{col}'
                      AND data_type   = 'timestamp without time zone'
                ) THEN
                    ALTER TABLE attendance_logs
                        ALTER COLUMN {col} TYPE TIME
                        USING ({col}::TIME);
                END IF;
            END $$;
        """)

    for old_constraint in (
        "attendance_logs_emp_emp_no_key",
        "attendance_logs_emp_no_date_key",
        # The ACTUAL name Postgres auto-generated for table_init.py's
        # original `UNIQUE (emp, emp_no, attendance_date)` -- the two
        # guesses above never matched it, so it silently survived every
        # previous run of this migration alongside the newer
        # attendance_logs_emp_id_date_key constraint below. Harmless while
        # `emp` could be NULL (Postgres allows multiple NULLs in a unique
        # constraint), but once NULL `emp` values get backfilled (see
        # sync_bio.py's repair_null_emp_records), a placeholder row and a
        # real employee's row can collide on this old constraint even
        # though attendance_logs_emp_id_date_key -- the one that should
        # actually govern uniqueness now -- has no conflict at all.
        "attendance_logs_emp_emp_no_attendance_date_key",
    ):
        cur.execute(f"""
            ALTER TABLE attendance_logs
                DROP CONSTRAINT IF EXISTS {old_constraint};
        """)

    cur.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'attendance_logs_emp_id_date_key'
            ) THEN
                ALTER TABLE attendance_logs
                    ADD CONSTRAINT attendance_logs_emp_id_date_key
                    UNIQUE (emp_id, attendance_date);
            END IF;
        END $$;
    """)

    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_biometric_logs_pending_emp_time
        ON biometric_logs (emp_id, punch_time)
        WHERE processed = FALSE
    """)


# ---------------------------------------------------------------------------
# Main processor
# ---------------------------------------------------------------------------
def process_attendance(rebuild=False, employee_id=None):
    """Recompute complete shift windows; preserve raw logs and manual overrides.

    rebuild=True reprocesses stored punches with sequence inference.
    employee_id limits recomputation to one employee; default preserves batch behavior.
    """
    global _schema_ready
    db_conn = None
    has_lock = False
    lap = _Lap()

    try:
        db_conn = get_db_connection()
        cur     = db_conn.cursor()

        # APScheduler's max_instances only protects one scheduler process.
        # A database advisory lock prevents duplicate processing if another
        # process or host points at the same attendance database.
        cur.execute("SELECT pg_try_advisory_lock(%s)", (_PROCESS_ATTENDANCE_LOCK,))
        has_lock = cur.fetchone()[0]
        if not has_lock:
            print("Attendance processor already running; skipping this tick.")
            return

        lap.mark("acquire lock")

        # ── 1. Schema ──────────────────────────────────────────────────────
        if not _schema_ready:
            print("Checking attendance_logs schema...")
            ensure_matching_schema(cur)
            ensure_attendance_columns(cur)
            db_conn.commit()
            _schema_ready = True
            print("Schema OK.")

        lap.mark("schema check")

        # ── 2. Load shifts ─────────────────────────────────────────────────
        cur.execute("SELECT shift_name, start_time, end_time FROM shifts")
        shifts = [
            {"shift_name": row[0], "start_time": row[1], "end_time": row[2]}
            for row in cur.fetchall()
        ]
        shifts_by_name = {s["shift_name"].strip().casefold(): s for s in shifts}
        now = datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)
        print(f"Loaded {len(shifts)} shift(s): {[s['shift_name'] for s in shifts]}")

        # ── 4. Load scanner locations ──────────────────────────────────────
        cur.execute("SELECT scanner_id, location FROM scanners")
        scanner_location_map = {row[0]: row[1] for row in cur.fetchall()}
        print(f"Loaded {len(scanner_location_map)} scanner location(s).")

        lap.mark("load shifts+scanners")

        # ── 5. Pull unprocessed biometric logs ────────────────────────────
        # This first pass only drives (a) which employees/dates need
        # recomputing, and (b) which biometric_logs rows get marked
        # processed at the end -- it is NOT used directly to compute
        # time_in/time_out. See step 6 for why.
        if rebuild:
            # Full rebuild reads every punch anyway, so the original single scan is fine.
            cur.execute("""
                SELECT bl.id, bl.emp_id, bl.punch_time
                FROM biometric_logs bl
                WHERE NOT backend.attendance_scan_blocked(bl.emp_id::text, bl.emp::text, bl.emp_no::text, bl.punch_time)
                  AND (%s IS NULL OR bl.emp_id = %s)
                  AND (bl.processed = FALSE OR %s
                   OR EXISTS (
                       SELECT 1 FROM attendance_logs al
                       WHERE al.emp_id = bl.emp_id
                         AND (al.matching_status = 'PROVISIONAL'
                              OR COALESCE(al.review_reason, '') LIKE '%%PENDING_OUT%%')
                         AND bl.punch_time::date BETWEEN al.attendance_date - 1 AND al.attendance_date + 1
                   ))
                ORDER BY bl.emp_id, bl.punch_time
            """, (employee_id, employee_id, rebuild))
        else:
            # Same rows as the single-scan form above, but the candidate ids are
            # found first (unprocessed punches + punches near PROVISIONAL /
            # PENDING_OUT days) and only THEN is the per-row
            # attendance_scan_blocked() function evaluated. The old form ran that
            # function and an EXISTS subquery against EVERY row of biometric_logs
            # on every tick, so the tick (and the advisory lock) got slower as
            # the table grew.
            cur.execute("""
                SELECT bl.id, bl.emp_id, bl.punch_time
                FROM biometric_logs bl
                WHERE bl.id IN (
                        SELECT u.id FROM biometric_logs u
                        WHERE u.processed = FALSE AND (%(eid)s IS NULL OR u.emp_id = %(eid)s)
                        UNION
                        SELECT b2.id
                        FROM attendance_logs al
                        JOIN biometric_logs b2 ON b2.emp_id = al.emp_id
                        WHERE (al.matching_status = 'PROVISIONAL'
                               OR COALESCE(al.review_reason, '') LIKE '%%PENDING_OUT%%')
                          AND b2.punch_time::date BETWEEN al.attendance_date - 1 AND al.attendance_date + 1
                          AND (%(eid)s IS NULL OR b2.emp_id = %(eid)s)
                      )
                  AND NOT backend.attendance_scan_blocked(bl.emp_id::text, bl.emp::text, bl.emp_no::text, bl.punch_time)
                ORDER BY bl.emp_id, bl.punch_time
            """, {"eid": employee_id})
        unprocessed_rows = cur.fetchall()
        print(f"Fetched {len(unprocessed_rows)} unprocessed biometric log row(s).")
        lap.mark("find unprocessed punches")

        if not unprocessed_rows:
            print("Nothing to process.")
            lap.report("idle tick", min_total=1.0)   # only noisy if it was slow
            return

        all_processed_ids = [r[0] for r in unprocessed_rows]
        affected_emp_ids  = sorted({r[1] for r in unprocessed_rows})
        punch_dates       = [r[2].date() for r in unprocessed_rows]
        history = load_schedule_history(cur, affected_emp_ids)
        schedule_dates, assignments = load_confirmations(cur, affected_emp_ids)
        lap.mark("load schedule history")

        # Initial affected range for logging. After loading all raw events for
        # the affected employees, expand writes to their complete date range.
        window_start = min(punch_dates) - timedelta(days=1)
        window_end = max(punch_dates) + timedelta(days=1)
        read_start = window_start - timedelta(days=1)
        read_end = window_end + timedelta(days=1)

        cur.execute("""
            SELECT
                bl.scanner_id,
                bl.emp,
                bl.emp_no,
                bl.emp_id,
                bl.employee_status,
                bl.punch_time,
                -- NULLIF(..., '') on the joined-name fallback: when both
                -- last_name and first_name are blank/NULL (most commonly
                -- an UNKNOWN/RESIGNED punch with no employee_groupings
                -- match at all), the bare TRIM(... || ', ' || ...) below
                -- evaluates to a lone "," -- TRIM only strips whitespace,
                -- not the comma itself. NULLIF collapses that empty-name
                -- case to a real NULL instead of a stray "," landing in
                -- attendance_logs.full_name.
                COALESCE(
                    eg.full_name,
                    NULLIF(TRIM(COALESCE(eg.last_name, '') || ', ' || COALESCE(eg.first_name, '')), ',')
                ) AS full_name, bl.id, bl.punch_type
            FROM biometric_logs bl
            LEFT JOIN frontend.employee_groupings eg
                ON eg.emp_id = bl.emp_id
            WHERE bl.emp_id = ANY(%s)
              AND NOT backend.attendance_scan_blocked(bl.emp_id::text, bl.emp::text, bl.emp_no::text, bl.punch_time)
            ORDER BY bl.emp_id, bl.punch_time
        """, (affected_emp_ids,))

        rows = cur.fetchall()
        lap.mark("load full punch history")
        print(f"Re-fetched {len(rows)} total punch row(s) (full history) "
              f"for {len(affected_emp_ids)} affected employee(s) "
              f"[{window_start} .. {window_end}].")

        # Load complete history of affected employees. This avoids unstable
        # sequence choices at artificial date-window boundaries.
        if rows:
            window_start = min(r[5].date() for r in rows) - timedelta(days=1)
            window_end = max(r[5].date() for r in rows) + timedelta(days=1)
        cur.execute("""SELECT emp_id, attendance_date, time_in_at, time_out_at,
                              time_in, time_out, shift_name
                       FROM attendance_logs WHERE emp_id = ANY(%s) AND manual_override = TRUE""", (affected_emp_ids,))
        reserved = defaultdict(list)
        for eid, day, tin_at, tout_at, tin, tout, name in cur.fetchall():
            shift = shifts_by_name.get((name or '').strip().casefold())
            if tin_at is None and tin is not None: tin_at = datetime.combine(day, tin)
            if tout_at is None and tout is not None:
                tout_at = datetime.combine(day, tout)
                if (tin_at and tout_at < tin_at) or (not tin_at and shift and shift['end_time'] <= shift['start_time'] and tout < shift['start_time']):
                    tout_at += timedelta(days=1)
            reserved[eid].extend(t for t in (tin_at,tout_at) if t is not None)
        by_employee = defaultdict(list)
        for row in rows:
            if any(abs((row[5]-t).total_seconds()) <= PUNCH_DEDUPE_WINDOW_SECONDS for t in reserved[row[3]]):
                continue
            by_employee[row[3]].append(row)
        groups = {}
        for emp_id, employee_rows in by_employee.items():
            for record in infer_employee(employee_rows, shifts_by_name, assignments):
                groups.setdefault((emp_id, record['day']), []).append(record)
        attendance_records = []
        for (emp_id, work_date), parts in groups.items():
            evidence=[]
            for part in parts:
                for event in part['events']:
                    evidence.append({'at':event['at'].isoformat(),'scanner_id':event['row'][0],
                                     'raw_ids':event['ids'],'raw_times':event['raw_times'],
                                     'raw_punch_types':event.get('raw_types', []),
                                     'confirmed':bool(event['confirmed']),
                                     'proposed_attendance_date':part['day'].isoformat(),
                                     'proposed_shift':part['name'],
                                     'proposed_role':'IN' if event is part['tin'] else ('OUT' if event is part['tout'] else 'UNRESOLVED'),
                                     'alternatives':part.get('alternatives',[])})
            row=parts[0]['events'][0]['row']
            scanner_id, emp, emp_no, _, employee_status, _, full_name, _ = row[:8]
            tin,tout,shift,reasons,status=summarize_day(parts,now)
            schedule_names=set()
            if work_date in schedule_dates[emp_id]:
                schedule_names.add(schedule_dates[emp_id][work_date])
            else:
                for name, definition in shifts_by_name.items():
                    if schedule_at(history[emp_id], shift_bounds(work_date,definition)[0]) == name:
                        schedule_names.add(name)
            scheduled=shifts_by_name.get(next(iter(schedule_names))) if len(schedule_names)==1 else None
            # Roster history is informational only; it never affects matching or review.
            end=shift_bounds(work_date,shift)[1] if shift else None
            time_in=tin['at'] if tin else None;time_out=tout['at'] if tout else None
            start=shift_bounds(work_date,shift)[0] if shift else None
            # Late/undertime are meaningful only against an agreed schedule.
            ti_status=('Needs Review' if status=='NEEDS_REVIEW' else ('On Time' if time_in.replace(second=0,microsecond=0)<=start else 'Late')) if time_in and start else None
            to_status=('Needs Review' if status=='NEEDS_REVIEW' else ('Undertime' if time_out.replace(second=0,microsecond=0)<end else 'On Time')) if time_out and end else None
            margins=[part['margin'] for part in parts if part['margin'] is not None]
            attendance_records.append((
                emp_id,emp,emp_no,full_name,employee_status,work_date,
                time_in.time() if time_in else None,ti_status,scanner_location_map.get(tin['row'][0]) if tin else None,
                time_out.time() if time_out else None,to_status,scanner_location_map.get(tout['row'][0]) if tout else None,
                shift['shift_name'] if shift else None,time_in,time_out,status,';'.join(sorted(reasons)) or None,
                json.dumps(evidence),scheduled['shift_name'] if scheduled else None,
                shift['shift_name'] if shift else None,MATCHER_VERSION,min(margins) if margins else None,
            ))

        lap.mark("compute matching")

        # Remove obsolete derived groups only inside fully loaded target dates.
        # Administratively approved corrections must set manual_override=TRUE.
        cur.execute("""
            DELETE FROM attendance_logs al
            WHERE al.emp_id = ANY(%s)
              AND al.attendance_date BETWEEN %s AND %s
              AND al.manual_override = FALSE
              AND NOT EXISTS (
                  SELECT 1 FROM unnest(%s::varchar[], %s::date[]) AS v(emp_id, attendance_date)
                  WHERE v.emp_id = al.emp_id AND v.attendance_date = al.attendance_date
              )
        """, (affected_emp_ids, window_start, window_end,
              [key[0] for key in groups], [key[1] for key in groups]))

        lap.mark("delete obsolete")

        # ── 10. Upsert attendance_logs ──────────────────────────────────────
        print(f"Upserting {len(attendance_records)} attendance record(s)...")

        execute_values(
            cur,
            """
            INSERT INTO attendance_logs (
                emp_id, emp, emp_no, full_name, emp_status,
                attendance_date,
                time_in, time_in_status, time_in_location,
                time_out, time_out_status, time_out_location,
                shift_name, time_in_at, time_out_at, matching_status, review_reason, source_punches,
                scheduled_shift, inferred_shift, matching_method, sequence_margin
            )
            VALUES %s
            ON CONFLICT (emp_id, attendance_date)
            DO UPDATE SET
                -- Plain overwrite, not LEAST/GREATEST: EXCLUDED was computed
                -- from the COMPLETE punch history for this day (see step 6),
                -- so it is always the authoritative value -- including when
                -- it corrects a previously-stored time_in/time_out that came
                -- from a mislabeled punch. A merge-based approach could only
                -- ever extend the stored range in one direction and could
                -- never fix a wrong value once written.
                time_in           = EXCLUDED.time_in,
                time_out          = EXCLUDED.time_out,
                time_in_status    = EXCLUDED.time_in_status,
                time_out_status   = EXCLUDED.time_out_status,
                time_in_location  = EXCLUDED.time_in_location,
                time_out_location = EXCLUDED.time_out_location,
                full_name         = COALESCE(EXCLUDED.full_name,                attendance_logs.full_name),
                emp_status        = EXCLUDED.emp_status,
                emp               = EXCLUDED.emp,
                emp_no            = EXCLUDED.emp_no,
                shift_name        = EXCLUDED.shift_name,
                time_in_at        = EXCLUDED.time_in_at,
                time_out_at       = EXCLUDED.time_out_at,
                matching_status   = EXCLUDED.matching_status,
                review_reason     = EXCLUDED.review_reason,
                source_punches     = EXCLUDED.source_punches,
                scheduled_shift = EXCLUDED.scheduled_shift,
                inferred_shift = EXCLUDED.inferred_shift,
                matching_method = EXCLUDED.matching_method,
                sequence_margin = EXCLUDED.sequence_margin
            WHERE attendance_logs.manual_override = FALSE
            """,
            attendance_records,
            page_size=1000,
        )

        lap.mark("upsert attendance")

        # ── 11. Mark biometric_logs as processed ──────────────────────────
        print(f"Marking {len(all_processed_ids)} biometric log row(s) as processed...")
        cur.execute("""
            UPDATE biometric_logs
            SET processed = TRUE
            WHERE id = ANY(%s)
        """, (all_processed_ids,))

        db_conn.commit()
        lap.mark("mark processed + commit")
        print(f"Done. {len(attendance_records)} attendance record(s) upserted.")
        lap.report(f"{len(affected_emp_ids)} employees, {len(all_processed_ids)} punches")

    except Exception as e:
        print(f"ATTENDANCE PROCESSOR ERROR: {e}")
        if db_conn:
            db_conn.rollback()
        raise

    finally:
        if db_conn:
            if has_lock:
                try:
                    cur.execute("SELECT pg_advisory_unlock(%s)", (_PROCESS_ATTENDANCE_LOCK,))
                except Exception:
                    # Closing the session also releases an advisory lock.
                    pass
            db_conn.close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Shift-based attendance matching")
    parser.add_argument("--rebuild", action="store_true",
                        help="Recompute raw history with sequence inference; back up first")
    parser.add_argument("--employee-id", help="Recompute only this exact employee ID (e.g. E17095)")
    parser.add_argument("--init-schema", action="store_true", help="Create required columns/tables without processing attendance")
    args = parser.parse_args()
    if args.init_schema:
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_PROCESS_ATTENDANCE_LOCK,))
            ensure_matching_schema(cur)
            ensure_attendance_columns(cur)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        process_attendance(rebuild=args.rebuild, employee_id=args.employee_id)
