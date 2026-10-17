from flask import Flask, jsonify, request
import sys
import os
from db.database import get_db_connection
import traceback
import json
from datetime import datetime
import requests
app = Flask(__name__)
EMPLOYEE_GROUPINGS_SOURCE_URL = "http://192.9.224.6:5000/employee_groupings"
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BASE_DIR)

@app.route("/employee_groupings")
def employees():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT
                emp_id,
                emp_no,
                emp,
                last_name,
                first_name,
                full_name,
                position,
                department,
                line_name,
                shift,
                process,
                line,
                employee_status,
                date_hired,
                tenure,
                remarks,
                source,
                created_at,
                updated_at
            FROM frontend.employee_groupings
            ORDER BY emp_id
        """)
        rows = cur.fetchall()
        return jsonify([
            {
                "emp_id": r[0],
                "emp_no": r[1],
                "emp": r[2],
                "last_name": r[3],
                "first_name": r[4],
                "full_name": r[5],
                "position": r[6],
                "department": r[7],     
                "line_name": r[8],
                "shift": r[9],
                "process": r[10],
                "line": r[11],
                "employee_status": r[12],
                "date_hired": r[13],
                "tenure": r[14],
                "remarks": r[15],
                "source": r[16],
                "created_at": r[17],
                "updated_at": r[18]
            }
            for r in rows
        ])
    finally:
        if conn:
            conn.close()


# =========================================================
# EMPLOYEE_GROUPINGS CRUD
# =========================================================
# Same table the GET /employee_groupings route above reads from.
# emp_id is the primary key (agency-prefixed, e.g. "12" for THN,
# "N-12" for NATCORP, "C-12" for CCI, "E-12" for EMIS — see
# AGENCY_PREFIX_MAP in the frontend app's groupings.py for how it's built).
GROUPINGS_EDITABLE_FIELDS = {
    "emp_no", "emp", "last_name", "first_name", "full_name",
    "position", "department", "line_name", "shift", "process",
    "line", "employee_status", "date_hired", "tenure", 'remarks', "source",
}


@app.route("/employee_groupings/add", methods=["POST"])
def add_employee_grouping():
    conn = None
    try:
        body = request.get_json(force=True, silent=True) or {}
        emp_id = str(body.get("emp_id", "")).strip().upper()

        if not emp_id:
            return jsonify({"success": False, "message": "emp_id is required."}), 400

        fields = {k: v for k, v in body.items() if k in GROUPINGS_EDITABLE_FIELDS}

        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("""
            SELECT 1
            FROM frontend.employee_groupings
            WHERE emp_id=%s
        """, (emp_id,))

        if cur.fetchone():
            return jsonify({
                "success": False,
                "message": f"Employee {emp_id} already exists."
            }), 409

        columns = ["emp_id"] + list(fields.keys())
        placeholders = ["%s"] * len(columns)
        values = [emp_id] + list(fields.values())

        cur.execute(f"""
            INSERT INTO frontend.employee_groupings
            ({", ".join(columns)}, created_at, updated_at)
            VALUES
            ({", ".join(placeholders)}, NOW(), NOW())
        """, values)

        # Audit
        cur.execute("""
            INSERT INTO backend.employee_record_audit
            (
                emp_id,
                emp_no,
                emp,
                action,
                new_data
            )
            VALUES (%s,%s,%s,'ADDED',%s)
                """, (
            emp_id,
            fields.get("emp_no"),
            fields.get("emp"),
            json.dumps({
                "emp_id": emp_id,
                **fields
            }, default=str)))

        conn.commit()

        return jsonify({
            "success": True,
            "message": f"Employee {emp_id} created.",
            "emp_id": emp_id
        })

    except Exception as e:
        if conn:
            conn.rollback()
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        if conn:
            conn.close()


@app.route("/employee_groupings/update", methods=["PUT"])
def update_employee_grouping():
    conn = None
    try:
        body = request.get_json(force=True, silent=True) or {}

        emp_id = str(body.get("emp_id", "")).strip().upper()
        changes = body.get("changes", {})

        if not emp_id:
            return jsonify({"success": False, "message": "emp_id is required."}), 400

        safe_changes = {
            k: v
            for k, v in changes.items()
            if k in GROUPINGS_EDITABLE_FIELDS
        }

        if not safe_changes:
            return jsonify({
                "success": False,
                "message": "No editable fields supplied."
            }), 400

        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("SELECT pg_advisory_xact_lock(%s)", (4815162342,))
        # Fetch old row
        cur.execute("""
            SELECT *
            FROM frontend.employee_groupings
            WHERE emp_id=%s
        """, (emp_id,))

        columns = [d[0] for d in cur.description]
        row = cur.fetchone()

        if not row:
            return jsonify({
                "success": False,
                "message": f"{emp_id} not found."
            }), 404

        old_data = dict(zip(columns, row))

        set_clause = ", ".join(f"{k}=%s" for k in safe_changes)

        cur.execute(f"""
            UPDATE frontend.employee_groupings
            SET {set_clause},
                updated_at=NOW()
            WHERE emp_id=%s
        """, list(safe_changes.values()) + [emp_id])

        if "shift" in safe_changes and safe_changes["shift"] != old_data.get("shift"):
            cur.execute("""INSERT INTO frontend.employee_movements
                (emp_id, full_name, field_name, old_value, new_value, detected_at)
                VALUES (%s,%s,'SHIFT',%s,%s,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila'))""",
                (emp_id, old_data.get("full_name"), old_data.get("shift"), safe_changes["shift"]))
            cur.execute("""UPDATE backend.biometric_logs SET processed=FALSE
                WHERE emp_id=%s AND punch_time >=
                date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila') - INTERVAL '1 day'""", (emp_id,))

        # Fetch new row
        cur.execute("""
            SELECT *
            FROM frontend.employee_groupings
            WHERE emp_id=%s
        """, (emp_id,))

        new_data = dict(zip(columns, cur.fetchone()))

        # Audit
        cur.execute("""
            INSERT INTO backend.employee_record_audit
            (
                emp_id,
                emp_no,
                emp,
                action,
                changed_fields,
                old_data,
                new_data
            )
            VALUES
            (%s,%s,%s,'UPDATED',%s,%s,%s)
                            """, (
                emp_id,
                old_data["emp_no"],
                old_data["emp"],
                json.dumps(safe_changes, default=str),
                json.dumps(old_data, default=str),
                json.dumps(new_data, default=str)
            ))

        conn.commit()

        return jsonify({
            "success": True,
            "message": f"{emp_id} updated.",
            "fields_updated": list(safe_changes.keys())
        })

    except Exception as e:
        if conn:
            conn.rollback()
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        if conn:
            conn.close()


@app.route("/employee_groupings/delete/<emp_id>", methods=["DELETE"])
def delete_employee_grouping(emp_id):
    conn = None
    try:
        emp_id = emp_id.strip().upper()

        conn = get_db_connection()
        cur = conn.cursor()

        # Fetch employee
        cur.execute("""
        SELECT *
        FROM frontend.employee_groupings
        WHERE emp_id = %s
        """, (emp_id,))

        columns = [d[0] for d in cur.description]
        row = cur.fetchone()

        if not row:
            return jsonify({
        "success": False,
        "message": f"{emp_id} not found."
        }), 404

        old_data = dict(zip(columns, row))

        # Save audit FIRST
        cur.execute("""
        INSERT INTO backend.employee_record_audit
        (
        emp_id,
        emp_no,
        action_type,
        changed_by,
        old_data
        )
        VALUES
        (
        %s,
        %s,
        'DELETE',
        'SYSTEM',
        %s
        )
        """, (
        old_data["emp_id"],
        old_data["emp_no"],
        json.dumps(old_data, default=str)
        ))

        # Delete employee
        cur.execute("""
        DELETE FROM frontend.employee_groupings
        WHERE emp_id = %s
        """, (emp_id,))

        conn.commit()

        return jsonify({
        "success": True,
        "message": f"{emp_id} deleted."
        })

    except Exception as e:
        if conn:
            conn.rollback()
            traceback.print_exc()

        return jsonify({
        "success": False,
        "error": str(e)
        }), 500

    finally:
        if conn:
            conn.close()


@app.route("/agencies")
def agencies():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT emp, agency_code FROM agencies")
        rows = cur.fetchall()
        return jsonify([{"agency_id": r[0], "agency_code": r[1]} for r in rows])
    finally:
        if conn:
            conn.close()

@app.route("/scanners")
def scanners():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT scanner_id, emp, ip_address, location, created_at
            FROM scanners
        """)
        rows = cur.fetchall()
        return jsonify([
            {
                "scanner_id": r[0], "agency_id":  r[1],
                "ip_address": r[2], "location":   r[3],
                "created_at": r[4],
            }
            for r in rows
        ])
    finally:
        if conn:
            conn.close()

@app.route("/attendance/biometric_logs")
def biometric_logs():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT
                b.scanner_id,
                b.emp_id,
                e.last_name,
                e.first_name,
                b.punch_time,
                b.punch_type,
                b.processed,
                b.created_at
            FROM backend.biometric_logs b
            LEFT JOIN frontend.employee_groupings e ON b.emp_id = e.emp_id
            ORDER BY b.punch_time DESC
        """)
        rows = cur.fetchall()
        return jsonify([
            {
                "scanner_id":  r[0], "emp_id": r[1],
                "last_name":   r[2], "first_name":  r[3],
                "punch_time":  r[4], "punch_type":  r[5],
                "processed":   r[6], "created_at":  r[7],
            }
            for r in rows
        ])
    finally:
        if conn:
            conn.close()

@app.route("/attendance/attendance-logs", methods=["GET"])
def get_attendance_logs():
    filters, params = [], []
    for key, operator in (("start_date", ">="), ("end_date", "<=")):
        value = request.args.get(key)
        if value:
            try:
                from datetime import date as filter_date
                value = filter_date.fromisoformat(value)
            except ValueError:
                return jsonify({"success": False, "error": key + " must use YYYY-MM-DD"}), 400
            filters.append("attendance_date " + operator + " %s")
            params.append(value)
    if len(params) == 2 and params[0] > params[1]:
        return jsonify({"success": False, "error": "start_date must not exceed end_date"}), 400
    where_sql = " WHERE " + " AND ".join(filters) if filters else ""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(f"""
            SELECT
                emp_id, emp, emp_no, full_name, emp_status,
                attendance_date, time_in, time_in_status, time_in_location,
                time_out, time_out_status, time_out_location, shift_name,
                scheduled_shift, inferred_shift, matching_status, review_reason,
                time_in_at, time_out_at, source_punches, matching_method, sequence_margin
            FROM backend.attendance_logs
            {where_sql}
            ORDER BY attendance_date DESC, full_name
        """, tuple(params))
        rows = cur.fetchall()
        data = [
            {
                "emp_id":             row[0],
                "emp":                row[1],
                "emp_no":             row[2],
                "full_name":          row[3],
                "emp_status":         row[4],
                "attendance_date":    str(row[5])  if row[5]  else None,
                "time_in":            str(row[6])  if row[6]  else None,
                "time_in_status":     row[7],
                "time_in_location":   row[8],
                "time_out":           str(row[9])  if row[9]  else None,
                "time_out_status":    row[10],
                "time_out_location":  row[11],
                "shift_name":         row[12],
                "scheduled_shift": row[13], "inferred_shift": row[14],
                "matching_status": row[15], "review_reason": row[16],
                "time_in_at": row[17].isoformat() if row[17] else None,
                "time_out_at": row[18].isoformat() if row[18] else None,
                "source_punches": row[19], "matching_method": row[20],
                "sequence_margin": row[21],
            }
            for row in rows
        ]
        return jsonify({"success": True, "count": len(data), "data": data})

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()

# =========================================================
# NO WORK SCHEDULE — HR-declared "no work needed" days
# =========================================================
# A row scopes to one specific employee (emp_id set), or to a whole
# line/shift (emp_id NULL, line_name and/or shift set) for plant/line-wide
# shutdown days. /resolved expands scoped rows into concrete emp_ids
# against frontend.employee_groupings, so callers never need to know
# about the scoping rules themselves.
@app.route("/attendance/no-work", methods=["GET"])
def list_no_work():
    conn = None
    try:
        target_date = request.args.get("date")
        conn = get_db_connection()
        cur = conn.cursor()

        if target_date:
            cur.execute("""
                SELECT id, emp_id, line_name, shift, work_date, reason, created_by, created_at
                FROM frontend.no_work_schedule
                WHERE work_date = %s
                ORDER BY created_at DESC
            """, (target_date,))
        else:
            cur.execute("""
                SELECT id, emp_id, line_name, shift, work_date, reason, created_by, created_at
                FROM frontend.no_work_schedule
                WHERE work_date >= CURRENT_DATE
                ORDER BY work_date, created_at DESC
            """)

        rows = cur.fetchall()
        return jsonify([
            {
                "id": r[0], "emp_id": r[1], "line_name": r[2], "shift": r[3],
                "work_date": str(r[4]) if r[4] else None,
                "reason": r[5], "created_by": r[6],
                "created_at": str(r[7]) if r[7] else None,
            }
            for r in rows
        ])

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.route("/attendance/no-work/resolved", methods=["GET"])
def resolved_no_work():
    """
    Expand no_work_schedule rows for ?date=YYYY-MM-DD into a concrete list
    of emp_ids. Callers (e.g. the dashboard's validation endpoints) use this
    instead of reading no_work_schedule + employee_groupings themselves.
    """
    conn = None
    try:
        target_date = request.args.get("date")
        if not target_date:
            return jsonify({"success": False, "message": "date is required."}), 400

        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("""
            SELECT emp_id, line_name, shift
            FROM frontend.no_work_schedule
            WHERE work_date = %s
        """, (target_date,))
        scheduled = cur.fetchall()

        direct_ids = {str(r[0]).strip().upper() for r in scheduled if r[0]}
        scoped     = [(r[1], r[2]) for r in scheduled if not r[0] and (r[1] or r[2])]

        if scoped:
            cur.execute("""
                SELECT emp_id, line_name, shift FROM frontend.employee_groupings
            """)
            for emp_id, line_name, shift in cur.fetchall():
                for scope_line, scope_shift in scoped:
                    if scope_line and str(line_name or "").strip().lower() != scope_line.strip().lower():
                        continue
                    if scope_shift and str(shift or "").strip().lower() != scope_shift.strip().lower():
                        continue
                    direct_ids.add(str(emp_id).strip().upper())

        return jsonify({"success": True, "date": target_date, "emp_ids": sorted(direct_ids)})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.route("/attendance/no-work/add", methods=["POST"])
def add_no_work():
    """
    Body:
      { "work_date": "2026-08-03", "emp_ids": ["1222","1509"], "reason": "..." }
    or
      { "work_date": "2026-08-03", "line_name": "Packing", "shift": "Day Shift" }
    """
    conn = None
    try:
        body       = request.get_json(force=True, silent=True) or {}
        work_date  = str(body.get("work_date", "")).strip()
        emp_ids    = body.get("emp_ids") or []
        line_name  = body.get("line_name")
        shift      = body.get("shift")
        reason     = body.get("reason", "")
        created_by = str(body.get("created_by", "SYSTEM")).strip()

        if not work_date:
            return jsonify({"success": False, "message": "work_date is required."}), 400
        if not emp_ids and not line_name and not shift:
            return jsonify({
                "success": False,
                "message": "Provide emp_ids, or a line_name/shift scope.",
            }), 400

        conn = get_db_connection()
        cur = conn.cursor()

        inserted, skipped = 0, []

        if emp_ids:
            for emp_id in emp_ids:
                emp_id = str(emp_id).strip().upper()
                cur.execute("""
                    SELECT 1 FROM frontend.no_work_schedule
                    WHERE emp_id = %s AND work_date = %s
                """, (emp_id, work_date))
                if cur.fetchone():
                    skipped.append(emp_id)
                    continue

                cur.execute("""
                    INSERT INTO frontend.no_work_schedule
                        (emp_id, work_date, reason, created_by)
                    VALUES (%s, %s, %s, %s)
                """, (emp_id, work_date, reason, created_by))
                inserted += 1
        else:
            cur.execute("""
                INSERT INTO frontend.no_work_schedule
                    (line_name, shift, work_date, reason, created_by)
                VALUES (%s, %s, %s, %s, %s)
            """, (line_name, shift, work_date, reason, created_by))
            inserted = 1

        conn.commit()
        return jsonify({"success": True, "inserted": inserted, "skipped_existing": skipped})

    except Exception as e:
        if conn:
            conn.rollback()
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.route("/attendance/no-work/delete/<int:entry_id>", methods=["DELETE"])
def delete_no_work(entry_id):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("SELECT 1 FROM frontend.no_work_schedule WHERE id = %s", (entry_id,))
        if not cur.fetchone():
            return jsonify({"success": False, "message": f"No entry with id {entry_id}."}), 404

        cur.execute("DELETE FROM frontend.no_work_schedule WHERE id = %s", (entry_id,))
        conn.commit()

        return jsonify({"success": True, "deleted_id": entry_id})

    except Exception as e:
        if conn:
            conn.rollback()
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# Editable fields the frontend is allowed to change.
# Any field not in this set is silently ignored.
EDITABLE_FIELDS = {
    "time_in",
    "time_in_status",
    "time_in_location",
    "time_out",
    "time_out_status",
    "time_out_location",
    "shift_name",
    "emp_status",
}

@app.route("/attendance/attendance-logs/override", methods=["PUT"])
def override_attendance_log():
    """
    Manually update — or create — one attendance_logs row.

    Expected JSON body:
    {
        "emp_id":          "THN-1222",          -- required, identifies the row
        "attendance_date": "2026-06-27",         -- required, identifies the row
        "emp_no":          "1222",               -- required ONLY when no row exists yet
        "changed_by":      "admin_username",     -- required, stored in audit
        "changes": {                             -- at least one field required
            "time_in":         "07:55:00",
            "time_in_status":  "On Time",
            "time_out":        "17:10:00",
            "time_out_status": "On Time",
            "shift_name":      "Day Shift",
            "emp_status":      "ACTIVE"
        }
    }"""

    conn = None
    try:
        body = request.get_json(force=True, silent=True) or {}

        emp_id          = str(body.get("emp_id",          "")).strip()
        emp_no          = str(body.get("emp_no",          "")).strip()
        attendance_date = str(body.get("attendance_date", "")).strip()
        changed_by      = str(body.get("changed_by",      "system")).strip()
        changes         = body.get("changes", {})

        # ── Validate ───────────────────────────────────────────────────────
        if not emp_id or not attendance_date:
            return jsonify({
                "success": False,
                "message": "emp_id and attendance_date are required."
            }), 400

        if not changes:
            return jsonify({
                "success": False,
                "message": "No changes provided."
            }), 400

        # Filter to only allowed editable fields
        safe_changes = {k: v for k, v in changes.items() if k in EDITABLE_FIELDS}

        if not safe_changes:
            return jsonify({
                "success": False,
                "message": f"None of the provided fields are editable. Allowed: {sorted(EDITABLE_FIELDS)}"
            }), 400

        conn = get_db_connection()
        cur  = conn.cursor()

        cur.execute("SELECT pg_advisory_xact_lock(%s)", (4815162342,))
        # ── Fetch current row (if any) ─────────────────────────────────────
        cur.execute("""
            SELECT
                emp_id, emp_no, emp_status,
                attendance_date,
                time_in, time_in_status, time_in_location,
                time_out, time_out_status, time_out_location,
                shift_name
            FROM backend.attendance_logs
            WHERE emp_id = %s AND attendance_date = %s
        """, (emp_id, attendance_date))

        existing = cur.fetchone()

        if existing:
            # ── UPDATE path (unchanged from before) ─────────────────────────
            old_data = {
                "emp_id":             existing[0],
                "emp_no":             existing[1],
                "emp_status":         existing[2],
                "attendance_date":    str(existing[3]) if existing[3] else None,
                "time_in":            str(existing[4]) if existing[4] else None,
                "time_in_status":     existing[5],
                "time_in_location":   existing[6],
                "time_out":           str(existing[7]) if existing[7] else None,
                "time_out_status":    existing[8],
                "time_out_location":  existing[9],
                "shift_name":         existing[10],
            }

            new_data = {**old_data, **safe_changes}

            set_clauses = ", ".join(f"{col} = %s" for col in safe_changes)
            set_values  = list(safe_changes.values())

            cur.execute(
                f"""
                UPDATE backend.attendance_logs
                SET {set_clauses}
                WHERE emp_id = %s AND attendance_date = %s
                """,
                set_values + [emp_id, attendance_date],
            )

            action_type   = "UPDATE"
            audit_emp_no  = existing[1]

        else:
            # ── INSERT path (new) ────────────────────────────────────────────
            # No row for this employee/date — e.g. present but never logged in.
            if not emp_no:
                return jsonify({
                    "success": False,
                    "message": "emp_no is required to create a new attendance record (no existing row was found)."
                }), 400

            old_data = None  # nothing existed before this

            base_row = {
                "emp_id":             emp_id,
                "emp_no":             emp_no,
                "emp_status":         "ACTIVE",
                "attendance_date":    attendance_date,
                "time_in":            None,
                "time_in_status":     None,
                "time_in_location":   None,
                "time_out":           None,
                "time_out_status":    None,
                "time_out_location":  None,
                "shift_name":         None,
            }

            new_data = {**base_row, **safe_changes}

            columns             = list(new_data.keys())
            insert_cols         = ", ".join(columns)
            insert_placeholders = ", ".join(["%s"] * len(columns))

            cur.execute(
                f"""
                INSERT INTO backend.attendance_logs ({insert_cols})
                VALUES ({insert_placeholders})
                """,
                [new_data[c] for c in columns],
            )

            action_type  = "INSERT"
            audit_emp_no = emp_no

        # Protect reviewed UI corrections and reserve their full endpoints.
        cur.execute("""UPDATE backend.attendance_logs
            SET manual_override=TRUE, matching_status='CONFIRMED',
                review_reason=NULL, matching_method='manual',
                inferred_shift=shift_name,
                time_in_at=attendance_date + time_in,
                time_out_at=attendance_date + time_out +
                    CASE WHEN time_out < time_in OR (time_in IS NULL AND
                         lower(COALESCE(shift_name,'')) LIKE '%night%' AND time_out < TIME '12:00')
                         THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END
            WHERE emp_id=%s AND attendance_date=%s""", (emp_id,attendance_date))
        cur.execute("""UPDATE backend.biometric_logs SET processed=FALSE
            WHERE emp_id=%s AND punch_time::date BETWEEN %s::date - 1 AND %s::date + 1""",
            (emp_id,attendance_date,attendance_date))

        # ── Write audit record ─────────────────────────────────────────────
        cur.execute("""
            INSERT INTO backend.employee_record_audit
                (emp_id, emp_no, action_type, changed_by, old_data, new_data, changed_at)
            VALUES
                (%s, %s, %s, %s, %s, %s, NOW())
        """, (
            emp_id,
            audit_emp_no,
            action_type,
            changed_by,
            json.dumps(old_data) if old_data is not None else None,
            json.dumps(new_data),
        ))

        conn.commit()

        return jsonify({
            "success":        True,
            "message":        f"Attendance record for {emp_id} on {attendance_date} "
                               f"{'created' if action_type == 'INSERT' else 'updated'}.",
            "action":         action_type,
            "fields_updated": list(safe_changes.keys()),
            "old_data":       old_data,
            "new_data":       new_data,
        })

    except Exception as e:
        if conn:
            conn.rollback()
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        if conn:
            conn.close()

@app.route("/attendance/audit", methods=["GET"])
def get_all_audit_logs():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("""
            SELECT
                audit_id,
                emp_id,
                emp_no,
                action_type,
                changed_by,
                old_data,
                new_data,
                changed_at
            FROM backend.employee_record_audit
            ORDER BY changed_at DESC
        """)

        rows = cur.fetchall()

        return jsonify([
            {
                "audit_id": row[0],
                "emp_id": row[1],
                "emp_no": row[2],
                "action_type": row[3],
                "changed_by": row[4],
                "old_data": row[5],
                "new_data": row[6],
                "changed_at": row[7].isoformat() if row[7] else None
            }
            for row in rows
        ])

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        if conn:
            conn.close()

# =========================================================
# AUDIT LOG — retrieve history for one employee
# =========================================================
@app.route("/attendance/audit/<emp_id>", methods=["GET"])
def get_audit_log(emp_id: str):
    """
    Return all manual-override audit entries for a given emp_id,
    newest first.
    """
    conn = None
    try:
        conn = get_db_connection()
        cur  = conn.cursor()
        cur.execute("""
            SELECT
                audit_id,
                emp_id,
                emp_no,
                action_type,
                changed_by,
                old_data,
                new_data,
                changed_at
            FROM backend.employee_record_audit
            WHERE emp_id = %s
            ORDER BY changed_at DESC
        """, (emp_id,))

        rows = cur.fetchall()

        return jsonify([
            {
                "audit_id":    row[0],
                "emp_id":      row[1],
                "emp_no":      row[2],
                "action_type": row[3],
                "changed_by":  row[4],
                "old_data":    row[5],
                "new_data":    row[6],
                "changed_at":  str(row[7]),
            }
            for row in rows
        ])

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        if conn:
            conn.close()

# =========================================================
# MOVEMENTS
# =========================================================
@app.route("/api/movements-summary", methods=["GET"])
def get_movements_summary():
    conn = None
    try:
        conn = get_db_connection()
        cur  = conn.cursor()

        cur.execute("""
            SELECT id, filename, imported_at
            FROM frontend.import_batches
            ORDER BY id DESC LIMIT 1
        """)
        latest = cur.fetchone()

        if not latest:
            return jsonify({"batch": None, "movements": []})

        batch_id = latest[0]

        cur.execute("""
            SELECT emp_id, full_name, field_name, old_value, new_value, detected_at
            FROM frontend.employee_movements
            WHERE to_batch_id = %s
            ORDER BY full_name
        """, (batch_id,))

        rows = cur.fetchall()

        return jsonify({
            "batch": {
                "id":          latest[0],
                "filename":    latest[1],
                "imported_at": str(latest[2]),
            },
            "movements": [
                {
                    "emp_id":      row[0],
                    "full_name":   row[1],
                    "field_name":  row[2],
                    "old_value":   row[3],
                    "new_value":   row[4],
                    "detected_at": str(row[5]),
                }
                for row in rows
            ],
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route("/api/employee-movements/<emp_id>", methods=["GET"])
def get_employee_movements(emp_id: str):
    conn = None
    try:
        conn = get_db_connection()
        cur  = conn.cursor()

        cur.execute("""
            SELECT
                m.field_name,
                m.old_value,
                m.new_value,
                b_from.filename,
                b_from.imported_at,
                b_to.filename,
                b_to.imported_at,
                m.detected_at
            FROM frontend.employee_movements m
            LEFT JOIN frontend.import_batches b_from ON b_from.id = m.from_batch_id
            LEFT JOIN frontend.import_batches b_to   ON b_to.id   = m.to_batch_id
            WHERE m.emp_id = %s
            ORDER BY m.detected_at DESC
        """, (emp_id,))

        rows = cur.fetchall()

        return jsonify([
            {
                "field_name": row[0],
                "old_value":  row[1],
                "new_value":  row[2],
                "from_file":  row[3],
                "from_date":  str(row[4]) if row[4] else None,
                "to_file":    row[5],
                "to_date":    str(row[6]) if row[6] else None,
                "detected_at": str(row[7]),
            }
            for row in rows
        ])

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

# =========================================================
# USERS
# =========================================================
@app.route("/api/users", methods=["GET"])
def get_users():
    conn = None
    try:
        conn = get_db_connection()
        cur  = conn.cursor()
        cur.execute("""
            SELECT username, first_name, last_name, roles
            FROM frontend.users
            ORDER BY first_name
        """)
        rows = cur.fetchall()
        return jsonify([
            {
                "username":   row[0],
                "first_name": row[1],
                "last_name":  row[2],
                "roles":      row[3],
            }
            for row in rows
        ])
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()
@app.route("/api/employee-roster", methods=["GET"])
def get_employee_roster():
    """
    Server-side proxy for the employee_groupings service on 192.9.224.6.

    The browser can't call 192.9.224.6:5000 directly (blocked by CORS,
    since that service doesn't send Access-Control-Allow-Origin headers).
    Fetching it here instead — server to server — sidesteps that
    entirely, since the browser only ever talks to this app's own origin.
    """
    try:
        resp = requests.get(EMPLOYEE_GROUPINGS_SOURCE_URL, timeout=5)
        resp.raise_for_status()
        return jsonify(resp.json())

    except requests.exceptions.RequestException as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "message": f"Could not reach employee roster service: {str(e)}"
        }), 502
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)