"""
scanner_attendance_sync.py
--------------------------
Pulls attendance logs from every scanner listed in your Postgres
`scanners` table (scanner_id, scanner_type, emp, ip_address, location,
created_at), enriches each record against your `employees` table, and
writes the result into an `attendance_logs` table.

Now supports two scanner types, dispatched by `scanners.scanner_type`:
    - "Anviz"      -> AnvizEP300 (tc-b_new_sdk.dll)
    - "David-Link" -> FM1100Client (raw socket, see fm1100_client.py)
      NOTE: adjust SCANNER_TYPE_FM1100 below to match whatever string is
      actually stored in your scanner_type column for the FM1100 devices.

Requires:
    pip install psycopg2-binary
    (anviz_ep300.py and fm1100_client.py must be in the same folder /
    importable)

Same environment caveat as anviz_ep300.py: tc-b_new_sdk.dll is 32-bit, so
this must run under 32-bit Python on Windows. fm1100_client.py has no such
constraint (pure-Python socket code).

IMPORTANT -- FM1100 CAVEAT (please read):
    fm1100_client.FM1100Client can correctly decode records once they
    arrive, but its connect()/download_all_records()/
    download_all_new_records() are stubs -- the FM1100's login/handshake
    and download-trigger command bytes are still unknown (this device
    doesn't speak standard zkprotocol). Until those are reverse-engineered
    from a packet capture, FM1100 scanners will only pick up records the
    device happens to push on its own after connecting -- this script
    can't yet actively request a download from them. Anviz scanners are
    unaffected by this.

SCHEMA NOTES / ASSUMPTIONS (please double check these against reality) ---
1. `scanners`: scanner_id, scanner_type, emp, ip_address, location,
   created_at
   - `emp` = employer/agency id (integer), matching the `emp` column on
     the employees table. Also used to pick each scanner's port, since
     the table itself has no port column: see EMP_PORT_MAP below
     (currently emp=1 -> 4370, emp=4 -> 5010). Add entries as needed;
     DEFAULT_PORT is just a fallback for unmapped emp values. If an
     FM1100 device needs a different port than the Anviz device on the
     same emp, add a dedicated entry keyed some other way -- ports here
     are only keyed by emp today, not by (emp, scanner_type).
2. Employee matching is scoped by agency too: the same numeric
   employee_id from two different agencies' devices won't collide,
   since lookup_employee() filters on employees.emp == scanners.emp.
3. `employees` table -- I've assumed this table is named
   frontend.employee_groupings; if it's called something else, change
   EMPLOYEES_TABLE below. Columns used for the lookup/enrichment:
     emp_id, emp_no, emp, last_name, first_name, full_name, position,
     department, line_name, shift, process, line, employee_status
   - The device sends back a raw numeric employee_id (decoded from the
     terminal's record). I match that against `emp_no` (cast to text),
     scoped by `emp` (agency), since emp_no reads like the human-facing
     badge/employee number that would've been enrolled on the scanner.
     If your device enrollment actually uses `emp_id` instead, change
     EMPLOYEE_MATCH_COLUMN below.
4. `attendance_logs` -- table doesn't exist yet as far as I know, so this
   script creates it (CREATE TABLE IF NOT EXISTS) with a schema that
   carries both the raw scan and the enriched employee fields. Review the
   DDL in ensure_attendance_table() and adjust column names/types before
   running against a real environment -- I'm inferring reasonable names,
   not copying an existing schema.
   A unique constraint on (scanner_id, employee_id, timestamp) is used so
   re-running a sync (e.g. after "download new records") won't create
   duplicate rows.
---------------------------------------------------------------------------
"""

import os

import psycopg2
import psycopg2.extras

from anviz_ep300 import AnvizEP300, AttendanceRecord
from fm1100_client import FM1100Client

# ---------------------------------------------------------------------------
# Config -- adjust to match your setup
# ---------------------------------------------------------------------------

PG_DSN = {
    "host": os.environ.get("PGHOST", "localhost"),
    "port": os.environ.get("PGPORT", 5432),
    "dbname": os.environ.get("PGDATABASE", "attendance_db"),
    "user": os.environ.get("PGUSER", "postgres"),
    "password": os.environ.get("PGPASSWORD", "1234"),
}

DLL_PATH = r"C:\Users\THN\Desktop\attendance_backend\tc-b_new_sdk.dll"
DOWNLOAD_MODE = "all"        # "new" = only undownloaded records, "all" = full dump
POLL_TIMEOUT_SECONDS = 120    # idle window per scanner before moving to the next

# scanner_type values as stored in backend.scanners -- verify these match
# your actual data (SELECT DISTINCT scanner_type FROM backend.scanners;)
SCANNER_TYPE_ANVIZ = "Anviz"
SCANNER_TYPE_FM1100 = "David-Link"
SUPPORTED_SCANNER_TYPES = (SCANNER_TYPE_ANVIZ, SCANNER_TYPE_FM1100)

# Port is keyed off scanners.emp (agency), not a per-row column.
# Add entries here as you onboard more agencies.
EMP_PORT_MAP = {
    1: 4370,
    4: 5010,
}
DEFAULT_PORT = 5010  # fallback if a scanner's emp isn't in EMP_PORT_MAP

DRY_RUN = True  # True = print results only, don't touch attendance_logs

EMPLOYEES_TABLE = "frontend.employee_groupings"
EMPLOYEE_MATCH_COLUMN = "emp_no"


def fetch_scanners(conn):
    """Reads scanner_id, scanner_type, emp, ip_address, location,
    created_at from the scanners table, for every supported scanner
    type."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT
                scanner_id,
                scanner_type,
                emp,
                ip_address,
                location,
                created_at
            FROM backend.scanners
            WHERE scanner_type = ANY(%s)
            ORDER BY scanner_id;""",
            (list(SUPPORTED_SCANNER_TYPES),),
        )
        return cur.fetchall()


def ensure_attendance_table(conn):
    """Creates attendance_logs if it doesn't already exist. Review/adjust
    this DDL for your environment before running for real -- these column
    names/types are a reasonable inference, not a copy of an existing
    table."""
    with conn.cursor() as cur:
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS attendance_logs (
                id               BIGSERIAL PRIMARY KEY,
                scanner_id       VARCHAR NOT NULL,
                scanner_type     VARCHAR,
                location         VARCHAR,
                agency           INTEGER,               -- from scanners.emp
                employee_id      VARCHAR,               -- raw id decoded off the device
                emp_id           VARCHAR,               -- FK-ish ref into {EMPLOYEES_TABLE}.emp_id, if matched
                full_name        VARCHAR,
                department       VARCHAR,
                position         VARCHAR,
                line_name        VARCHAR,
                shift            VARCHAR,
                employee_status  VARCHAR,
                machine_id       BIGINT,
                "timestamp"      TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                record_type      SMALLINT,
                new_record_flag  SMALLINT,
                cur_idx          BIGINT,
                total_cnt        BIGINT,
                source_format    VARCHAR,
                created_at       TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
                UNIQUE (scanner_id, employee_id, "timestamp")
            );
        """)
    conn.commit()


def lookup_employee(conn, employee_id: str, agency):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            f"""
            SELECT
                emp,
                emp_id,
                emp_no,
                first_name,
                last_name,
                full_name,
                department,
                position,
                line_name,
                shift,
                process,
                line,
                employee_status,
                date_hired,
                tenure,
                remarks
            FROM {EMPLOYEES_TABLE}
            WHERE {EMPLOYEE_MATCH_COLUMN}::text = %s
              AND emp = %s
            LIMIT 1
            """,
            (employee_id, agency),
        )

        row = cur.fetchone()

        if row:
            return dict(row)

        return {
            "emp": agency,
            "emp_id": None,
            "emp_no": None,
            "first_name": None,
            "last_name": None,
            "full_name": None,
            "department": None,
            "position": None,
            "line_name": None,
            "shift": None,
            "process": None,
            "line": None,
            "employee_status": None,
            "date_hired": None,
            "tenure": None,
            "remarks": None,
        }


def get_sdk_for_scanner(scanner: dict, anviz_sdk: AnvizEP300 | None):
    """Returns the right SDK/client instance for a scanner's type.

    Anviz reuses one long-lived AnvizEP300 instance across all Anviz
    scanners (matches original behavior). FM1100 gets a fresh
    FM1100Client per scanner since each is just a plain socket -- there's
    no shared DLL session to reuse."""
    if scanner["scanner_type"] == SCANNER_TYPE_ANVIZ:
        if anviz_sdk is None:
            # Shouldn't happen -- main() only skips creating anviz_sdk
            # when there are no Anviz scanners in the fetched list -- but
            # guard anyway in case fetch_scanners()/main() drift apart.
            raise ValueError(
                "Got an Anviz scanner but anviz_sdk was never initialized"
            )
        return anviz_sdk, False  # False = caller should NOT stop() this after use
    elif scanner["scanner_type"] == SCANNER_TYPE_FM1100:
        client = FM1100Client()
        client.start()
        return client, True  # True = caller should stop() this after use
    else:
        raise ValueError(f"Unhandled scanner_type: {scanner['scanner_type']!r}")


def sync_scanner(sdk, scanner: dict) -> list:
    """Connects to a single scanner, triggers a download, and returns the
    decoded AttendanceRecords tagged with scanner metadata.

    Works against either AnvizEP300 or FM1100Client since both expose the
    same connect/poll/download_all_records/download_all_new_records/
    get_record_status/_dev_type_flags interface. For FM1100, download
    triggers are currently no-ops (see fm1100_client.py docstring) so
    only records the device pushes unprompted will show up."""
    ip = scanner["ip_address"]
    port = EMP_PORT_MAP.get(scanner["emp"], DEFAULT_PORT)
    print(f"[scanner {scanner['scanner_id']}] ({scanner['scanner_type']}) "
          f"connecting to {ip}:{port} (emp={scanner['emp']}, "
          f"{scanner['location']})...")

    sdk.connect(ip, port)
    sdk.poll(timeout_seconds=3)  # let the device log in before triggering a download

    dev_idx = 1  # single device per connection in this flow
    if DOWNLOAD_MODE == "all":
        sdk.download_all_records(dev_idx)
        records = sdk.poll(timeout_seconds=10)

        if not records and hasattr(sdk, "tm_download_all_records"):
            sdk.tm_download_all_records(dev_idx)
            records = sdk.poll(timeout_seconds=POLL_TIMEOUT_SECONDS)
    else:
        sdk.download_all_new_records(dev_idx)
        records = sdk.poll(timeout_seconds=POLL_TIMEOUT_SECONDS)

    print_attendance_records(scanner, records)
    return records


def print_attendance_records(scanner: dict, records: list):
    """Prints already-decoded records in a clean, human-readable form --
    no raw object reprs, no debug noise. record_type is shown in hex
    since it's really a small bitfield (verify method / punch state), not
    a meaningful decimal number."""
    print(f"\n========== ATTENDANCE LOGS: scanner {scanner['scanner_id']} "
          f"({scanner['scanner_type']}, {scanner['location']}) ==========")

    if not records:
        print("No attendance logs returned by the scanner.")
        return

    for i, r in enumerate(records, 1):
        print(f"""
    Record #{i}
    ----------------------------------------
    Machine ID      : {r.machine_id}
    Employee ID     : {r.employee_id}
    Timestamp       : {r.timestamp.strftime('%Y-%m-%d %H:%M:%S')}
    Record Type     : {hex(r.record_type)}
    New Record Flag : {r.new_record_flag}
    Current Index   : {r.cur_idx}
    Total Records   : {r.total_cnt}
    Format          : {r.source_format}""")

    print(f"\n[scanner {scanner['scanner_id']}] retrieved {len(records)} records")


def print_rows(rows):
    """Dry-run output: prints each enriched record instead of writing to
    the DB, so you can eyeball the decoding/enrichment before trusting it
    with real inserts."""
    headers = [
        "scanner_id", "scanner_type", "location", "agency", "employee_id",
        "emp_id", "full_name", "department", "position", "line_name",
        "shift", "employee_status", "machine_id", "timestamp",
        "record_type", "new_record_flag", "cur_idx", "total_cnt",
        "source_format",
    ]
    print(f"\n--- {len(rows)} record(s) (DRY RUN -- not written to DB) ---")
    for row in rows:
        print(dict(zip(headers, row)))


def main():
    conn = psycopg2.connect(**PG_DSN)
    if not DRY_RUN:
        ensure_attendance_table(conn)

    scanners = fetch_scanners(conn)
    print(f"Found {len(scanners)} scanners")

    # Only spin up the Anviz DLL session if there's actually an Anviz
    # scanner to talk to -- avoids the 32-bit DLL dependency on machines
    # that only have FM1100 devices.
    anviz_sdk = None
    if any(s["scanner_type"] == SCANNER_TYPE_ANVIZ for s in scanners):
        anviz_sdk = AnvizEP300(dll_path=DLL_PATH)
        anviz_sdk.start()
        print(f"SDK version: {anviz_sdk._dll.CChex_Version()}")

    all_rows = []
    for scanner in scanners:
        try:
            sdk, should_stop = get_sdk_for_scanner(scanner, anviz_sdk)
        except ValueError as exc:
            print(f"[scanner {scanner['scanner_id']}] SKIPPED: {exc}")
            continue

        try:
            records = sync_scanner(sdk, scanner)
        except Exception as exc:
            print(f"[scanner {scanner['scanner_id']}] FAILED: {exc}")
            continue
        finally:
            if should_stop:
                sdk.stop()

        for r in records:
            emp = lookup_employee(conn, r.employee_id, scanner["emp"])
            print("\n" + "=" * 90)
            print(f"Scanner ID       : {scanner['scanner_id']}")
            print(f"Scanner Type     : {scanner['scanner_type']}")
            print(f"Location         : {scanner['location']}")
            print(f"Agency           : {scanner['emp']}")
            print("-" * 90)
            print(f"Device Employee# : {r.employee_id}")
            print(f"Employee ID      : {emp['emp_id']}")
            print(f"Employee No      : {emp['emp_no']}")
            print(f"Full Name        : {emp['full_name']}")
            print(f"Department       : {emp['department']}")
            print(f"Position         : {emp['position']}")
            print(f"Line             : {emp['line_name']}")
            print(f"Shift            : {emp['shift']}")
            print(f"Process          : {emp['process']}")
            print(f"Employee Status  : {emp['employee_status']}")
            print(f"Date Hired       : {emp['date_hired']}")
            print(f"Tenure           : {emp['tenure']}")
            print("-" * 90)
            print(f"Machine ID       : {r.machine_id}")
            print(f"Biometric Time   : {r.timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"Record Type      : {hex(r.record_type)}")
            print(f"New Record Flag  : {r.new_record_flag}")
            print(f"Current Record   : {r.cur_idx}")
            print(f"Total Records    : {r.total_cnt}")
            print(f"Format           : {r.source_format}")
            print("=" * 90)

            all_rows.append((
                scanner["scanner_id"], scanner["scanner_type"],
                scanner["location"], scanner["emp"], r.employee_id,
                emp["emp_id"], emp["full_name"], emp["department"],
                emp["position"], emp["line_name"], emp["shift"],
                emp["employee_status"], r.machine_id, r.timestamp,
                r.record_type, r.new_record_flag, r.cur_idx, r.total_cnt,
                r.source_format,
            ))

    if anviz_sdk is not None:
        anviz_sdk.stop()

    if all_rows:
        if DRY_RUN:
            print_rows(all_rows)
        else:
            print(f"Synced {len(all_rows)} records across {len(scanners)} scanners.")
    else:
        print("No records retrieved from any scanner.")

    conn.close()


if __name__ == "__main__":
    main()