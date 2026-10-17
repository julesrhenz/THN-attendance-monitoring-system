from flask import Blueprint, request, jsonify
import traceback
from sqlalchemy import text as sa_text
import requests
import json
from routes.decorators import login_required, admin_required, level_2_to_4_required
from routes.auth import bulk_delete_required
from routes.extensions import db

employees_bp = Blueprint("employees", __name__)

AGENCY_ID_MAP = {"THN": 1, "CCI": 2, "NATCORP": 3, "EMIS": 4}
REMOTE_EMPLOYEE_API = "http://192.9.224.6:5000/employee_groupings/delete"
def delete_employee(emp_id: str, conn):
    emp_id = str(emp_id).strip().upper()

    print(f"Deleting: {emp_id}")

    response = requests.delete(
        f"{REMOTE_EMPLOYEE_API}/{emp_id}",
        timeout=10
    )

    print("Remote URL:", f"{REMOTE_EMPLOYEE_API}/{emp_id}")
    print("Remote Status:", response.status_code)
    print("Remote Body:", response.text)

    if response.status_code == 404:
        print("Not found remotely, skipping.")
        return 0

    response.raise_for_status()

    print("Deleted via remote service.")
    return 1

@employees_bp.route("/api/employees")
@login_required
def api_employees():
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text("""
                SELECT emp_id, emp_no, emp, last_name, first_name, full_name,
                       line_name, line, shift, process, date_hired, tenure, gender, updated_at
                FROM frontend.employee_groupings
                ORDER BY last_name, first_name
            """)).mappings().all()
        return jsonify([dict(r) | {"updated_at": str(r["updated_at"]) if r["updated_at"] else None,
                                    "date_hired": str(r["date_hired"]) if r["date_hired"] else None}
                        for r in rows])
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@employees_bp.route("/api/employees/add", methods=["POST"])
@level_2_to_4_required
def api_employees_add():
    try:
        payload = request.json or {}
        emp_no_raw = str(payload.get("emp_no", "")).strip()
        emp_id = payload.get("emp_id", emp_no_raw).strip().upper()

        # emp_no should be the plain number, not the prefixed ID
        # e.g. "N-7355" -> "7355", but plain "7355" (THN) stays as-is
        emp_no = emp_no_raw.split("-")[-1] if "-" in emp_no_raw else emp_no_raw

        agency_prefix = emp_id.split("-")[0].upper() if "-" in emp_id else "THN"

        row = {
            "emp_id": emp_id,
            "emp_no": emp_no,
            "emp": AGENCY_ID_MAP.get(agency_prefix),
            "last_name": payload.get("last_name", ""),
            "first_name": payload.get("first_name", ""),
            "full_name": payload.get("full_name", ""),
            "line_name": payload.get("line_name"),
            "line": payload.get("line"),
            "shift": payload.get("shift"),
            "position": payload.get("position"),   # ← IDAGDAG ITO
            "process": payload.get("process"),
            "date_hired": payload.get("date_hired"),
            "tenure": payload.get("tenure"),
            "gender": payload.get("gender"),
        }

        with db.engine.begin() as conn:
            # 1) Insert the new employee
            conn.execute(sa_text("""
                INSERT INTO frontend.employee_groupings
                    (emp_id, emp_no, emp, last_name, first_name, full_name,
                    line_name, line, shift, position, process, date_hired, tenure, gender, updated_at)
                VALUES
                    (:emp_id, :emp_no, :emp, :last_name, :first_name, :full_name,
                    :line_name, :line, :shift, :position, :process, :date_hired, :tenure, :gender, NOW())
                ON CONFLICT (emp_id) DO NOTHING
            """), row)

            # 2) Log the action to employee_record_audit
            conn.execute(sa_text("""
                INSERT INTO backend.employee_record_audit
                    (action_type, changed_at, changed_by, emp_id, emp_no, new_data, old_data)
                VALUES
                    (:action_type, NOW(), :changed_by, :emp_id, :emp_no,
                     CAST(:new_data AS JSONB), NULL)
            """), {
                "action_type": "INSERT",
                "changed_by": "SYSTEM",
                "emp_id": emp_id,
                "emp_no": emp_no,
                "new_data": json.dumps(row),
            })

        return jsonify({"success": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500
@employees_bp.route("/api/employees/update", methods=["PUT"])
@level_2_to_4_required
def api_employees_update():
    try:
        payload = request.json or {}
        emp_id = str(payload.get("emp_id", "")).strip().upper()
        if not emp_id:
            return jsonify({"success": False, "message": "emp_id is required."}), 400

        with db.engine.begin() as conn:
            # 1) Fetch the current row BEFORE updating, for the audit log
            old_row = conn.execute(sa_text("""
                SELECT emp_id, emp_no, emp, last_name, first_name, full_name,
                       line_name, line, shift, process, date_hired, tenure, gender
                FROM frontend.employee_groupings
                WHERE emp_id = :emp_id
            """), {"emp_id": emp_id}).mappings().first()

            if not old_row:
                return jsonify({"success": False, "message": "Employee not found."}), 404

            old_data = dict(old_row)
            # Convert non-JSON-serializable types (e.g. dates) to strings
            old_data = {k: (str(v) if v is not None else None) for k, v in old_data.items()}

            # 2) Perform the update
            conn.execute(sa_text("""
                UPDATE frontend.employee_groupings
                SET last_name = :last_name, first_name = :first_name, full_name = :full_name,
                    line_name = :line_name, line = :line, shift = :shift,
                    process = :process, date_hired = :date_hired, tenure = :tenure,
                    gender = :gender,
                    updated_at = NOW()
                WHERE emp_id = :emp_id
            """), {**payload, "emp_id": emp_id})

            new_data = {**old_data, **{
                "last_name": payload.get("last_name"),
                "first_name": payload.get("first_name"),
                "full_name": payload.get("full_name"),
                "line_name": payload.get("line_name"),
                "line": payload.get("line"),
                "shift": payload.get("shift"),
                "process": payload.get("process"),
                "date_hired": payload.get("date_hired"),
                "tenure": payload.get("tenure"),
                "gender": payload.get("gender"),
            }}

            # 3) Log the action to employee_record_audit
            conn.execute(sa_text("""
                INSERT INTO backend.employee_record_audit
                    (action_type, changed_at, changed_by, emp_id, emp_no, new_data, old_data)
                VALUES
                    (:action_type, NOW(), :changed_by, :emp_id, :emp_no,
                     CAST(:new_data AS JSONB), CAST(:old_data AS JSONB))
            """), {
                "action_type": "UPDATE",
                "changed_by": "SYSTEM",
                "emp_id": emp_id,
                "emp_no": old_data.get("emp_no"),
                "new_data": json.dumps(new_data),
                "old_data": json.dumps(old_data),
            })

        return jsonify({"success": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500
@employees_bp.route("/api/employees/delete/<emp_id>", methods=["DELETE"])
@level_2_to_4_required
def api_employees_delete(emp_id: str):
    try:

        with db.engine.begin() as conn:

            deleted = delete_employee(emp_id, conn)

            if deleted == 0:
                return jsonify({
                    "success": False,
                    "message": "Employee not found locally."
                }), 404

        return jsonify({
            "success": True
        })

    except requests.exceptions.HTTPError as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "message": f"Remote server error: {e.response.text}"
        }), 500

    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "message": str(e)
        }), 500
@employees_bp.route("/api/users")
@login_required
def get_users():
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text("""
                SELECT username, first_name, last_name, roles
                FROM frontend.users ORDER BY first_name
            """)).fetchall()
        return jsonify([{
            "username": r[0], "first_name": r[1],
            "last_name": r[2], "roles": r[3],
        } for r in rows])
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@employees_bp.route("/api/debug-users-schema")
@admin_required
def debug_users_schema():
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text(
                "SELECT column_name, data_type "
                "FROM information_schema.columns "
                "WHERE table_schema = 'frontend' AND table_name = 'users' "
                "ORDER BY ordinal_position"
            )).fetchall()
        return jsonify([{"column": r[0], "type": r[1]} for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500
@employees_bp.route("/api/employees/bulk-delete", methods=["PUT"])
@bulk_delete_required
def bulk_delete_employees():
    payload = request.get_json() or {}
    employee_ids = payload.get("employee_ids", [])

    if not employee_ids:
        return jsonify({
            "success": False,
            "message": "No employees selected."
        }), 400

    deleted = 0
    failures = []

    for emp_id in employee_ids:
        try:
            # each employee gets its own transaction, so one
            # failure doesn't roll back or block the others
            with db.engine.begin() as conn:
                rows = delete_employee(emp_id, conn)
                if rows > 0:
                    deleted += 1
                else:
                    failures.append({"emp_id": emp_id, "reason": "Not found locally."})

        except requests.exceptions.HTTPError as e:
            traceback.print_exc()
            failures.append({
                "emp_id": emp_id,
                "reason": f"Remote server error: {e.response.text}"
            })
        except Exception as e:
            traceback.print_exc()
            failures.append({"emp_id": emp_id, "reason": str(e)})

    return jsonify({
        "success": len(failures) == 0,
        "deleted": deleted,
        "failures": failures
    }), 200
