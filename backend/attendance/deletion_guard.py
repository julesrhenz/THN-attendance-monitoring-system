"""Persistent deletion cutoffs. Scanner timestamps and cutoffs use Manila local time.

Do not attach this to import/roster replacement: only explicit employee deletion
creates a block. A later Excel upload cannot erase it.
"""
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS backend.employee_attendance_blocks (
    emp_id TEXT PRIMARY KEY,
    emp TEXT,
    emp_no TEXT,
    blocked_from TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    reason TEXT NOT NULL DEFAULT 'EMPLOYEE_DELETED'
);
CREATE INDEX IF NOT EXISTS employee_attendance_blocks_identity
    ON backend.employee_attendance_blocks (emp, emp_no);
CREATE OR REPLACE FUNCTION backend.attendance_employee_number(value TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $fn$
    SELECT CASE WHEN btrim(value) ~ '^[0-9]+$'
           THEN COALESCE(NULLIF(ltrim(btrim(value), '0'), ''), '0')
           ELSE upper(btrim(value)) END
$fn$;
CREATE OR REPLACE FUNCTION backend.attendance_scan_blocked(
    employee_id TEXT, agency TEXT, employee_number TEXT, stamp TIMESTAMP WITHOUT TIME ZONE)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $fn$
    SELECT EXISTS (
        SELECT 1 FROM backend.employee_attendance_blocks d
        WHERE stamp >= d.blocked_from
          AND (upper(btrim(employee_id)) = d.emp_id OR
               (btrim(agency) = d.emp AND
                backend.attendance_employee_number(employee_number) = d.emp_no))
    )
$fn$;
"""


def ensure_deletion_schema(cur):
    cur.execute(SCHEMA_SQL)
