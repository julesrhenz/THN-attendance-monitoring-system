from flask import Blueprint, request, jsonify, session
import requests
from sqlalchemy import text as sa_text
from datetime import datetime, date, time as dtime
import traceback
import json
import re
from datetime import datetime, date, time as dtime, timedelta
from routes.extensions import db
from routes.decorators import login_required, admin_required, line_leader_required, level_2_to_4_required
from routes.http_client import get_json, put_json, attendance_window_url
from routes.auth import can_view_employee, can_view_group, is_hr_approver, hr_approval_required

attendance_bp = Blueprint("attendance", __name__)

ATTENDANCE_URL      = "http://192.9.224.6:5000/attendance/attendance_summary"
ATTENDANCE_LOGS_URL = "http://192.9.224.6:5000/attendance/attendance-logs"
NO_WORK_BASE_URL = "http://192.9.224.6:5000/attendance/no-work"

EDITABLE_ATTENDANCE_FIELDS = {
    "time_in", "time_in_status", "time_in_location",
    "time_out", "time_out_status", "time_out_location",
    "shift_name", "emp_status",
}

# Time-In adjustment request lifecycle (see attendance_time_in_requests
# table / routes near the bottom of this file). Two-stage approval:
#   Pending First Approval -> Pending HR Approval -> Approved
# The live attendance record is only ever written to at the FINAL (HR)
# approval step — never at submission, and never at the first-approval
# step. Kept as constants instead of raw strings so the frontend's exact
# labels only have to be typed correctly once.
TIME_IN_REQUEST_STATUS_PENDING_FIRST = "Pending First Approval"
TIME_IN_REQUEST_STATUS_PENDING_HR    = "Pending HR Approval"
TIME_IN_REQUEST_STATUS_APPROVED      = "Approved"
TIME_IN_REQUEST_STATUS_DECLINED      = "Declined"

# Shift thresholds
DAY_SHIFT_START    = dtime(7, 0, 0)
DAY_SHIFT_LATE      = dtime(7, 1, 0)
DAY_SHIFT_END       = dtime(16, 0, 0)
DAY_SHIFT_OT_END    = dtime(21, 0, 0)

NIGHT_SHIFT_START   = dtime(19, 0, 0)
NIGHT_SHIFT_LATE    = dtime(19, 1, 0)
NIGHT_SHIFT_END     = dtime(4, 0, 0)
NIGHT_SHIFT_OT_END  = dtime(7, 0, 0)   # night shift 7 PM -> 4 AM; OT allowed until 7 AM

EXPECTED_BENCHMARK  = 394

# emp_status values that mark a scanner log row as not belonging to a real,
# currently active employee (e.g. "UNKNOWN/RESIGNED"). Rows like this can
# still show up in attendance-logs after someone leaves, with emp: null and
# a placeholder full_name — they must not be counted as present/late/absent
# for anyone.
INVALID_EMP_STATUS_MARKERS = ("UNKNOWN", "RESIGNED")


def parse_date(value: object):
    for fmt in ("%Y-%m-%d", "%a, %d %b %Y %H:%M:%S GMT"):
        try:
            return datetime.strptime(str(value).strip(), fmt).date()
        except Exception:
            pass
    return None


def is_valid_checkin(value: object) -> bool:
    INVALID = {"", "-", "none", "null", "no check-in yet", "n/a", "na"}
    if not value:
        return False
    return str(value).strip().lower() not in INVALID


def is_valid_employee_record(record: dict) -> bool:
    """
    True if this attendance-log row belongs to a real, currently active
    employee and should be counted. Filters out orphaned rows such as
    {"emp_status": "UNKNOWN/RESIGNED", "emp": null, "full_name": ","} that
    the scanner system can still emit after someone leaves.
    """
    emp_status = str(record.get("emp_status", "") or "").strip().upper()
    return not any(marker in emp_status for marker in INVALID_EMP_STATUS_MARKERS)


def _fetch_shift_map():

    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT emp_id, emp_no, shift
            FROM frontend.employee_groupings
        """)).fetchall()

    shift_map = {}
    for emp_id, emp_no, shift in rows:
        shift = (shift or "").strip()
        if not shift:
            continue
        for raw_key in (emp_id, emp_no):
            if not raw_key:
                continue
            key = str(raw_key).strip().upper().split("-", 1)[-1]
            shift_map[key] = shift
    return shift_map


def _lookup_shift(shift_map: dict, *candidates) -> str:
    """
    Returns the first authoritative shift match for the given emp_id/emp_no
    candidates, normalized the same way as _fetch_shift_map(). Falls back to
    the empty string if none match (caller should fall back further to the
    feed's own shift_name if desired).
    """
    for raw in candidates:
        if not raw:
            continue
        key = str(raw).strip().upper().split("-", 1)[-1]
        if key in shift_map:
            return shift_map[key]
    return ""


# ── No-Work lookup ───────────────────────────────────────────────────────
# backend.attendance_time_in_requests-style helper for the /attendance/no-work
# feed (proxied via NO_WORK_BASE_URL below). "No Work" entries are per
# employee (emp_id/emp_no), for a specific date — e.g. a declared off day,
# suspension, or other scheduled non-attendance day. These employees must
# NOT be counted as "Absent" anywhere attendance status is computed.
def _fetch_no_work_records(target_date: str = None) -> list:
    """Raw records from frontend.no_work_schedule (this app's own DB —
    same schema as employee_groupings). Pass target_date (YYYY-MM-DD) to
    filter server-side for one day, or omit it to get every record on file
    (used by the per-employee history backfill, which needs every date at
    once rather than one call per day).

    CHANGED: previously proxied to the external NO_WORK_BASE_URL service.
    Switched to reading this table directly, matching create_no_work()
    below, which now writes here directly too — keeping both on the same
    source of truth avoids the emp_id/line_name/shift mismatches that
    came from guessing the external service's expected field names."""
    try:
        query = """
            SELECT emp_id, line_name, shift, work_date, reason, created_by, created_at
            FROM frontend.no_work_schedule
        """
        params = {}
        if target_date:
            query += " WHERE work_date = :work_date"
            params["work_date"] = target_date

        with db.engine.connect() as conn:
            rows = conn.execute(sa_text(query), params).mappings().all()
        return [dict(r) for r in rows]
    except Exception:
        traceback.print_exc()
        return []


def _no_work_key(record: dict) -> str:
    """Same emp_id/emp_no normalization used by _fetch_shift_map() etc.,
    so a no-work record lines up against roster emp_id and log emp_no."""
    raw = record.get("emp_id") or record.get("emp_no")
    return str(raw or "").strip().upper().split("-", 1)[-1]


def _fetch_no_work_employees(target_date: str) -> set:
    """Normalized emp keys marked 'No Work' for one specific date."""
    records = _fetch_no_work_records(target_date)
    return {_no_work_key(r) for r in records if isinstance(r, dict) and _no_work_key(r)}


def _parse_no_work_date(value):
    """Same as parse_date(), plus a fallback that grabs a leading
    YYYY-MM-DD out of the string — covers the no-work feed's `work_date`
    field in case it ever comes back with a time component
    (e.g. "2026-07-31T00:00:00") instead of a bare date."""
    d = parse_date(value)
    if d:
        return d
    match = re.match(r"(\d{4}-\d{2}-\d{2})", str(value or ""))
    return parse_date(match.group(1)) if match else None


def _fetch_no_work_dates_for_emp(emp_key: str) -> set:
    """All dates (date objects) marked 'No Work' for one employee, across
    every record on file — used by attendance_history()'s Absent-backfill
    loop so past No Work days aren't shown as Absent."""
    records = _fetch_no_work_records()
    dates = set()
    for r in records:
        if not isinstance(r, dict) or _no_work_key(r) != emp_key:
            continue
        d = _parse_no_work_date(r.get("work_date") or r.get("date") or r.get("no_work_date") or r.get("attendance_date", ""))
        if d:
            dates.add(d)
    return dates


# ── Scope lookup (Time-In request approval gating) ──────────────────────────
# backend.attendance_time_in_requests does not store department/line/shift
# columns of its own, so — same pattern as _fetch_shift_map()/_lookup_shift()
# above — a request's full visibility "scope" (department + line_name +
# shift) is resolved dynamically from frontend.employee_groupings via its
# emp_id/emp_no. This mirrors what the live attendance dashboard does and
# means a request's scope always reflects the employee's *current* record
# rather than a snapshot frozen at submission time.
#
# Line_name/shift are included (not just department) so that LINE- and
# SECTION-level accounts (Levels 1-2 of the access matrix in auth.py), not
# only DEPARTMENT/GLOBAL accounts, are correctly gated here too — the old
# department-only version of this lookup could only ever check Level 3/4.
def _fetch_scope_map():
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT emp_id, emp_no, department, line_name, shift, gender
            FROM frontend.employee_groupings
        """)).fetchall()

    scope_map = {}
    for emp_id, emp_no, department, line_name, shift, gender in rows:
        scope = {
            "department": (department or "").strip(),
            "line_name":  (line_name or "").strip(),
            "shift":      (shift or "").strip(),
            "gender":     (gender or "").strip(),
        }
        for raw_key in (emp_id, emp_no):
            if not raw_key:
                continue
            key = str(raw_key).strip().upper().split("-", 1)[-1]
            scope_map[key] = scope
    return scope_map


def _lookup_scope(scope_map: dict, *candidates) -> dict:
    for raw in candidates:
        if not raw:
            continue
        key = str(raw).strip().upper().split("-", 1)[-1]
        if key in scope_map:
            return scope_map[key]
    return {"department": "", "line_name": "", "shift": "", "gender": ""}


# ── Display-name lookup (Time-In request approval queues) ──────────────────
# requested_by / first_approved_by / reviewed_by are stored as the acting
# account's username. The approval-queue tables must show first/last name
# instead — a raw username is not acceptable there — so this resolves
# username -> (first_name, last_name) via frontend.users in one query
# rather than per-row.
def _fetch_user_name_map():
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT username, first_name, last_name
            FROM frontend.users
        """)).fetchall()

    return {
        str(username).strip(): {"first_name": first_name, "last_name": last_name}
        for username, first_name, last_name in rows
        if username
    }


def _user_can_view_request(scope: dict) -> bool:
    """Session-bound wrapper around auth.can_view_employee() for use inside
    this file's request-approval routes. `scope` should come from
    _lookup_scope(_fetch_scope_map(), emp_id, emp_no) — it carries
    department + line_name + shift so LINE/SECTION-level accounts (not
    just DEPARTMENT/GLOBAL) are gated correctly, matching the same rules
    applied to the main employee dashboard.
    """
    return can_view_employee({
        "department": scope.get("department", ""),
        "line_name":  scope.get("line_name", ""),
        "shift":      scope.get("shift", ""),
    })


@attendance_bp.route("/api/logs/today")
@login_required
def logs_today():
    try:
        data = get_json(ATTENDANCE_URL, ttl=5, timeout=15, default=[])
    except Exception:
        return jsonify([])
    today = date.today()
    return jsonify([r for r in data if parse_date(r.get("attendance_date", "")) == today])


@attendance_bp.route("/api/logs/all")
@login_required
def logs_all():
    try:
        return jsonify(get_json(ATTENDANCE_URL, ttl=5, timeout=15, default=[]))
    except Exception:
        return jsonify([])


@attendance_bp.route("/api/attendance-logs")
@login_required
def attendance_logs_by_date():
    """Proxy and filter the canonical attendance-logs feed for the UI."""
    from routes.data import build_prefixed_id, record_emp_key, is_in_todays_window
 
    requested_date = request.args.get("date", date.today().isoformat()).strip()
    try:
        selected_date = datetime.strptime(requested_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"success": False, "message": "date must use YYYY-MM-DD."}), 400
 
    window_start = selected_date - timedelta(days=1) if selected_date == date.today() else selected_date
    payload = get_json(attendance_window_url(ATTENDANCE_LOGS_URL, window_start, selected_date), ttl=5, timeout=15, default={}) or {}
    records = payload.get("data", []) if isinstance(payload, dict) else payload
 
    shift_map = _fetch_shift_map()
    scope_map = _fetch_scope_map()
    no_work_map = _fetch_no_work_employees(selected_date.isoformat())
    leave_employees = _fetch_leave_employees()
    now = datetime.now().time()
    today = date.today()
 
    seen_ids = set()
    data = []
    for record in records:
        if not isinstance(record, dict) or not is_valid_employee_record(record):
            continue
 
        att_date_str = str(record.get("attendance_date", "")).strip()
        shift_name = record.get("inferred_shift") or record.get("shift_name") or _lookup_shift(shift_map, record.get("emp_id"), record.get("emp_no"))
 
        if selected_date == today:
            if not is_in_todays_window(att_date_str, shift_name, today, now):
                continue
        else:
            if parse_date(att_date_str) != selected_date:
                continue
 
        emp_id = record_emp_key(record)
        if not emp_id:
            emp_id = str(record.get("emp_id") or record.get("emp_no") or "").strip().upper()
 
        if emp_id in seen_ids:
            continue
        seen_ids.add(emp_id)
 
        time_in = record.get("time_in") if is_valid_checkin(record.get("time_in")) else None
 
        emp_key = str(record.get("emp_no") or emp_id).strip().upper().split("-", 1)[-1]
        is_no_work = emp_key in no_work_map
        is_on_leave = emp_key in leave_employees
 
        # Look the scope up ONCE per employee (was previously looked up
        # 3x below for department/line_name/gender, then AGAIN in a
        # second pass for the visibility filter — 5 lookups total for
        # data that doesn't change per-row). Reused for both the row
        # payload and the visibility check right here, so we can filter
        # inline and drop the second list comprehension entirely.
        scope = _lookup_scope(scope_map, emp_id, record.get("emp_no"))
        department = scope.get("department", "")
        line_name = scope.get("line_name", "")
 
        if not can_view_employee({
            "department": department,
            "line_name": line_name,
            "shift": _lookup_shift(shift_map, record.get("emp_id"), record.get("emp_no")) or shift_name,
        }):
            continue
 
        data.append({
            **record,
            "emp_id": emp_id,
            "full_name": str(record.get("full_name") or "Unknown").strip(),
            "position": record.get("position") or "",
            "time_in": time_in,
            "shift_name": shift_name,
            "status": "No Work" if is_no_work else ("On Leave" if is_on_leave else determine_roster_status(shift_name, time_in)),
            "no_work": is_no_work,
            "on_leave": is_on_leave,
            "department": department,
            "line_name": line_name,
            "gender": scope.get("gender", ""),
        })
 
    data.sort(key=lambda row: (str(row.get("full_name", "")).casefold(), str(row.get("emp_id", ""))))
    return jsonify({"success": True, "date": requested_date, "count": len(data), "data": data})


@attendance_bp.route("/api/attendance-export")
@login_required
def attendance_export():
    """Flat rows for the dashboard's "Export Attendance" (Excel) button.

    The ROSTER (frontend.employee_groupings) is the base, same as the line
    summary modal, so employees with no punch today (absent, on leave, no
    work) are included. Time In comes from today's logs via
    attendance_logs_by_date() (same date handling / shift window), and
    Remarks is the employee's own remark (VL, SL, fever, ...).

    Returns: { success, date, count, data: [ {id, name, line, process, time_in, remarks} ] }
    line = the line/group name (e.g. "L5 NS"); process = the section inside it
    (e.g. "Taping 7"). Either is "" when the employee has none (frontend
    shows those as "Unassigned").
    """
    base = attendance_logs_by_date()
    if isinstance(base, tuple):            # error response, e.g. bad date -> (resp, 400)
        return base
    payload = base.get_json() or {}
    if not payload.get("success"):
        return base

    def _key(raw):
        return str(raw or "").strip().upper().split("-", 1)[-1]

    def _first(row, *names):
        for n in names:
            v = row.get(n)
            if v is not None and str(v).strip():
                return str(v).strip()
        return ""

    log_rows = payload.get("data", [])
    logs = {}
    for rec in log_rows:
        for raw in (rec.get("emp_id"), rec.get("emp_no")):
            if raw:
                logs[_key(raw)] = rec

    # SELECT * (read by column name) so it works whichever of
    # "section" / "process" and "full_name" / "name" your table uses.
    with db.engine.connect() as conn:
        roster = conn.execute(sa_text("SELECT * FROM frontend.employee_groupings")).mappings().all()

    rows, seen = [], set()
    for row in roster:
        keys = [k for k in (_key(row.get("emp_id")), _key(row.get("emp_no"))) if k]
        if not keys or any(k in seen for k in keys):
            continue
        if not can_view_employee({
            "department": _first(row, "department"),
            "line_name": _first(row, "line_name"),
            "shift": _first(row, "shift"),
        }):
            continue
        seen.update(keys)

        rec = next((logs[k] for k in keys if k in logs), {})
        rows.append({
            "id": keys[0],
            "name": _first(row, "full_name", "name", "employee_name", "emp_name") or rec.get("full_name", ""),
            "line": _first(row, "line_name"),
            "process": _first(row, "section", "process"),
            "time_in": rec.get("time_in") or "",
            "remarks": _first(row, "remarks"),   # VL / SL / fever ... blank if none
        })

    # People who punched today but are not in the roster: keep them too.
    for rec in log_rows:
        keys = [k for k in (_key(rec.get("emp_id")), _key(rec.get("emp_no"))) if k]
        if not keys or any(k in seen for k in keys):
            continue
        seen.update(keys)
        rows.append({
            "id": keys[0],
            "name": rec.get("full_name", ""),
            "line": rec.get("line_name") or "",
            "process": "",
            "time_in": rec.get("time_in") or "",
            "remarks": "",
        })

    rows.sort(key=lambda r: (str(r["name"]).casefold(), str(r["id"])))
    return jsonify({"success": True, "date": payload.get("date"), "count": len(rows), "data": rows})

@attendance_bp.route("/api/logs/update", methods=["PUT"])
@level_2_to_4_required
def update_attendance():
    try:
        res = put_json(
            "http://192.9.224.6:5000/attendance/attendance_summary/manual_override",
            request.get_json(), timeout=20,
        )
        return jsonify(res.json()), res.status_code
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@attendance_bp.route("/api/attendance/override", methods=["PUT"])
@level_2_to_4_required
def override_attendance():
    """
    Manually edit an attendance_logs row.
    Creates the row if it doesn't exist yet (e.g. employee never scanned in).
    Stores old + new values in employee_record_audit.
    """
    try:
        body            = request.get_json(force=True, silent=True) or {}
        emp_id          = str(body.get("emp_id",          "")).strip()
        emp_no          = str(body.get("emp_no",          "")).strip() or None
        full_name       = str(body.get("full_name",       "")).strip() or None
        position        = str(body.get("position",        "")).strip() or None
        attendance_date = str(body.get("attendance_date", "")).strip()
        changed_by      = str(body.get("changed_by", session.get("username", "system"))).strip()
        changes         = body.get("changes", {})

        if not emp_id or not attendance_date:
            return jsonify({"success": False, "message": "emp_id and attendance_date are required."}), 400

        with db.engine.begin() as conn:
            try:
                old_data, new_data, safe_changes = _apply_attendance_changes(
                    conn, emp_id, emp_no, full_name, position,
                    attendance_date, changes, changed_by,
                )
            except ValueError as ve:
                return jsonify({"success": False, "message": str(ve)}), 400

        return jsonify({
            "success":        True,
            "fields_updated": list(safe_changes.keys()),
            "old_data":       old_data,
            "new_data":       new_data,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@attendance_bp.route("/api/attendance/audit/<emp_id>")
@login_required
def attendance_audit(emp_id: str):
    """Full manual-override audit history for one employee."""
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text("""
                SELECT audit_id, emp_id, emp_no, action_type,
                       changed_by, old_data, new_data, changed_at
                FROM employee_record_audit
                WHERE emp_id = :emp_id
                ORDER BY changed_at DESC
            """), {"emp_id": emp_id}).fetchall()

        return jsonify([{
            "audit_id":    r[0], "emp_id":      r[1],
            "emp_no":      r[2], "action_type": r[3],
            "changed_by":  r[4], "old_data":    r[5],
            "new_data":    r[6], "changed_at":  str(r[7]),
        } for r in rows])

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ── Shift status / validation ───────────────────────────────────────────────
def parse_time(time_str):
    if not time_str:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(time_str.strip(), fmt).time()
        except ValueError:
            continue
    return None


def determine_status(shift_name: str, time_in_str, now: dtime) -> str:
    time_in = parse_time(time_in_str)
    shift   = (shift_name or "").strip().lower()

    if "night" in shift:
        if time_in is not None:
            return "Late" if time_in >= NIGHT_SHIFT_LATE else "Present"
        if now < NIGHT_SHIFT_START and now > NIGHT_SHIFT_OT_END:
            return "Pending"
        if now > NIGHT_SHIFT_OT_END and now < NIGHT_SHIFT_START:
            return "Absent"
        return "Pending"

    if time_in is not None:
        return "Late" if time_in >= DAY_SHIFT_LATE else "Present"
    if now >= DAY_SHIFT_START:
        return "Absent"
    return "Pending"


def determine_roster_status(shift_name: str, time_in_str) -> str:
    time_in = parse_time(time_in_str)
    if time_in is None:
        return "Absent"

    shift = (shift_name or "").strip().lower()
    if "night" in shift:
        return "Late" if time_in >= NIGHT_SHIFT_LATE else "Present"
    return "Late" if time_in >= DAY_SHIFT_LATE else "Present"


def _fetch_today_logs():
    return (get_json(attendance_window_url(ATTENDANCE_LOGS_URL), default={}) or {}).get("data", [])

def _fetch_leave_employees():
    """
    Returns a set of emp_ids that currently have a value in the
    remarks column (On Leave).
    """
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT emp_id
            FROM frontend.employee_groupings
            WHERE remarks ~* '^[[:space:]]*(VL|SL|ML|SS|PL)([[:space:]-]|$)'
        """)).fetchall()

    return {
        str(r[0]).strip().upper().split("-", 1)[-1]
        for r in rows
    }
@attendance_bp.route("/api/attendance-status")
@login_required
def attendance_status():
    try:
        records = _fetch_today_logs()
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Failed to fetch logs: {str(e)}"}), 500

    now = datetime.now().time()
    today = date.today().isoformat()
    seen = set()
    results = []

    leave_employees = _fetch_leave_employees()
    no_work_employees = _fetch_no_work_employees(today)
    shift_map = _fetch_shift_map()

    for record in records:
        if not is_valid_employee_record(record):
            continue

        emp_no = str(record.get("emp_no", "")).strip()
        att_date = str(record.get("attendance_date", "")).strip()
        shift_name = _lookup_shift(shift_map, record.get("emp_id"), emp_no) or str(record.get("shift_name", "")).strip()
        time_in = record.get("time_in")

        if not emp_no or emp_no in seen or att_date != today:
            continue

        seen.add(emp_no)

        emp_key = emp_no.strip().upper().split("-", 1)[-1]
        if emp_key in leave_employees:
            status = "On Leave"
        elif emp_key in no_work_employees:
            status = "No Work"
        else:
            status = determine_status(shift_name, time_in, now)

        results.append({
            "emp_no": emp_no,
            "shift": shift_name,
            "time_in": time_in,
            "status": status,
            "att_date": att_date,
        })

    summary = {
        "present": sum(1 for r in results if r["status"] == "Present"),
        "late": sum(1 for r in results if r["status"] == "Late"),
        "absent": sum(1 for r in results if r["status"] == "Absent"),
        "pending": sum(1 for r in results if r["status"] == "Pending"),
        "on_leave": sum(1 for r in results if r["status"] == "On Leave"),
        "no_work": sum(1 for r in results if r["status"] == "No Work"),
        "total": len(results),
    }

    return jsonify({
        "success": True,
        "summary": summary,
        "records": results,
        "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })
def _thn_day_classification():
    """emp_id -> {agency, shift} for THN Day Shift, ADMIN excluded."""
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT emp_id, emp, shift, full_name
            FROM frontend.employee_groupings
        """)).fetchall()

    classification = {
        str(r[0]).strip().upper(): {
            "agency": str(r[1] or "").strip().upper(),
            "shift":  str(r[2] or "").strip(),
            "name":   r[3],
        }
        for r in rows
    }
    return {
        emp_id: info for emp_id, info in classification.items()
        if "day" in info["shift"].lower()
        and info["agency"] == "THN"
        and "ADMIN" not in info["agency"]
    }, classification


@attendance_bp.route("/api/attendance-validation")
@login_required
def attendance_validation():
    try:
        records = _fetch_today_logs()

        now = datetime.now().time()
        today = date.today().isoformat()

        leave_employees = _fetch_leave_employees()
        no_work_employees = _fetch_no_work_employees(today)
        shift_map = _fetch_shift_map()

        expected_roster, classification = _thn_day_classification()

        present = late = absent = pending = on_leave = no_work = 0
        seen, counted_emp_ids = set(), []

        for record in records:
            if not is_valid_employee_record(record):
                continue

            emp_no   = str(record.get("emp_no", "")).strip().upper()
            att_date = str(record.get("attendance_date", "")).strip()

            if not emp_no or emp_no in seen or att_date != today:
                continue
            if emp_no not in expected_roster:
                continue

            seen.add(emp_no)
            counted_emp_ids.append(emp_no)

            emp_key = emp_no.strip().upper().split("-", 1)[-1]
            if emp_key in leave_employees:
                status = "On Leave"
            elif emp_key in no_work_employees:
                status = "No Work"
            else:
                shift_name = _lookup_shift(shift_map, record.get("emp_id"), emp_no) or record.get("shift_name", "")
                status = determine_status(shift_name, record.get("time_in"), now)

            if status == "Present":
                present += 1
            elif status == "Late":
                late += 1
            elif status == "Absent":
                absent += 1
            elif status == "Pending":
                pending += 1
            elif status == "On Leave":
                on_leave += 1
            elif status == "No Work":
                no_work += 1

        total              = present + late + absent
        validation_passed  = (total == EXPECTED_BENCHMARK)

        result = {
            "success": True,
            "filter": {"shift": "Day Shift", "agency": "THN", "excluded": "ADMIN"},
            "present": present,
            "late": late,
            "absent": absent,
            "pending": pending,
            "on_leave": on_leave,
            "no_work": no_work,
            "total_present_late_absent": total,
            "expected_benchmark": EXPECTED_BENCHMARK,
            "validation_passed": validation_passed,
            "discrepancy": total - EXPECTED_BENCHMARK,
            "counted_emp_count": len(counted_emp_ids),
        }

        if not validation_passed:
            result["warning"] = (
                f"Checksum mismatch: expected {EXPECTED_BENCHMARK}, got {total}. "
                f"Discrepancy of {total - EXPECTED_BENCHMARK}."
            )

        return jsonify(result)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

@attendance_bp.route("/api/attendance-validation-debug")
@admin_required
def attendance_validation_debug():
    try:
        records = _fetch_today_logs()
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

    today = date.today().isoformat()
    expected_roster, _ = _thn_day_classification()

    seen, counted_emp_ids = set(), set()
    for record in records:
        if not is_valid_employee_record(record):
            continue
        emp_no   = str(record.get("emp_no", "")).strip().upper()
        att_date = str(record.get("attendance_date", "")).strip()
        if not emp_no or emp_no in seen or att_date != today:
            continue
        if emp_no not in expected_roster:
            continue
        seen.add(emp_no)
        counted_emp_ids.add(emp_no)

    missing_from_logs = [
        {"emp_id": emp_id, "name": info["name"]}
        for emp_id, info in expected_roster.items()
        if emp_id not in counted_emp_ids
    ]

    return jsonify({
        "expected_roster_count": len(expected_roster),
        "counted_today":         len(counted_emp_ids),
        "missing_employees":     missing_from_logs,
    })


@attendance_bp.route("/api/attendance-validation-debug2")
@admin_required
def attendance_validation_debug2():
    try:
        records = _fetch_today_logs()
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

    today = date.today().isoformat()
    all_today_emp_nos = {
        str(r.get("emp_no", "")).strip().upper()
        for r in records
        if str(r.get("attendance_date", "")).strip() == today and r.get("emp_no")
    }

    missing_emp_ids = [
        "1222", "1509", "12", "2374", "638", "1110", "1756", "2093", "79",
        "1257", "2604", "2487", "1152", "2129", "1190", "1558", "1612",
        "1391", "2781", "944", "2451", "2501", "1180", "2136", "2621", "654",
    ]

    return jsonify({
        "truly_no_attendance_record_at_all": [e for e in missing_emp_ids if e not in all_today_emp_nos],
        "has_record_but_excluded_by_filter": [e for e in missing_emp_ids if e in all_today_emp_nos],
    })
# How far back the per-employee history reads from the attendance-logs feed.
# None = keep the old behaviour (call ATTENDANCE_LOGS_URL with no date params).
# Set to e.g. 180 to request an explicit start_date/end_date window instead —
# useful if the upstream feed only returns a default/limited period when
# no params are given (compare len(records) of both to find out).
HISTORY_LOOKBACK_DAYS = None


def _fetch_history_records() -> list:
    if HISTORY_LOOKBACK_DAYS:
        today = date.today()
        url = attendance_window_url(
            ATTENDANCE_LOGS_URL, today - timedelta(days=HISTORY_LOOKBACK_DAYS), today
        )
    else:
        url = ATTENDANCE_LOGS_URL
    payload = get_json(url, ttl=5, timeout=15, default={}) or {}
    records = payload.get("data", []) if isinstance(payload, dict) else payload
    if not records:
        # get_json() silently returns the default on upstream failure, so an
        # empty feed here is the first thing to check when history is blank.
        print(f"ATTENDANCE HISTORY: empty feed from {url}")
    return records or []


def _history_row_key(record: dict) -> str:
    """Same employee key the main table uses (record_emp_key), with hyphens
    removed so \"N-12\" (roster) and \"N12\" (log) compare equal."""
    from routes.data import record_emp_key
    key = record_emp_key(record) or str(record.get("emp_id") or record.get("emp_no") or "")
    return key.strip().upper().replace("-", "")


@attendance_bp.route("/api/attendance-history/<emp_id>")
@login_required
def attendance_history(emp_id: str):
    # Lazy import — routes.data imports from this module.
    from routes.data import is_in_todays_window

    records = _fetch_history_records()
    shift_map = _fetch_shift_map()

    try:
        # FIX: match on the SAME key the main table uses (record_emp_key:
        # "12" for THN, "N12" for agency). The old code compared the
        # prefix-stripped id against record["emp_no"] only, so agency ids
        # ("N12") never matched ("12"), and THN "12" also pulled in agency
        # N12's rows that happen to share emp_no "12".
        target_full = emp_id.strip().upper().replace("-", "")
        # no-work / leave tables keep the original (prefix-before-hyphen) key.
        target = emp_id.strip().upper()
        if "-" in target:
            target = target.split("-", 1)[1]

        no_work_dates = _fetch_no_work_dates_for_emp(target)

        # "On Leave" (frontend.employee_groupings.remarks) is a live/current
        # flag, not a dated record like No Work — only applied to TODAY.
        today = date.today()
        now_t = datetime.now().time()
        on_leave_today = target in _fetch_leave_employees()

        # True when a record dated YESTERDAY already covers today's window
        # (night shift punched in last evening, viewed before 7 AM). The main
        # table shows that employee under today, so history must not
        # backfill today as Absent.
        covered_today = False

        history = []
        for record in records:
            if not is_valid_employee_record(record):
                continue
            if _history_row_key(record) != target_full:
                continue
            raw_emp_no = str(record.get("emp_no") or "").strip().upper()

            att_date = parse_date(record.get("attendance_date", ""))
            if att_date is None:
                continue
            raw_shift = str(record.get("shift_name") or "").strip()
            shift_name = raw_shift if record.get("matching_method") else (raw_shift or _lookup_shift(shift_map, record.get("emp_id"), raw_emp_no))
            time_in = record.get("time_in")
            time_in = time_in if is_valid_checkin(time_in) else None

            if att_date in no_work_dates:
                row_status = "No Work"
            elif att_date == today and on_leave_today:
                row_status = "On Leave"
            else:
                row_status = determine_roster_status(shift_name, time_in)

            history.append({
                "attendance_date": att_date,
                "shift_name": shift_name,
                "time_in": time_in,
                "time_out": record.get("time_out"),
                "status": "Needs Review" if record.get("matching_status") == "NEEDS_REVIEW" else row_status,
                "scheduled_shift": record.get("scheduled_shift"),
                "inferred_shift": record.get("inferred_shift"),
                "matching_status": record.get("matching_status"),
                "review_reason": record.get("review_reason"),
                "source_punches": record.get("source_punches"),
            })

            if att_date != today and is_in_todays_window(
                str(record.get("attendance_date", "")).strip(),
                record.get("inferred_shift") or shift_name,
                today, now_t,
            ):
                covered_today = True

        # --- backfill every scheduled (Mon–Sat) gap as Absent/No Work/On Leave ---
        if history:
            existing_dates = {h["attendance_date"] for h in history}
            start = min(existing_dates)
            end = max(max(existing_dates), today)

            cursor = start
            one_day = timedelta(days=1)
            while cursor <= end:
                if (cursor.weekday() != 6 and cursor not in existing_dates   # skip Sunday
                        and not (cursor == today and covered_today)):
                    if cursor in no_work_dates:
                        gap_status = "No Work"
                    elif cursor == today and on_leave_today:
                        gap_status = "On Leave"
                    else:
                        gap_status = "Absent"
                    history.append({
                        "attendance_date": cursor,
                        "shift_name": "",
                        "time_in": None,
                        "time_out": None,
                        "status": gap_status,
                    })
                cursor += one_day
        elif today.weekday() != 6:
            # No history at all — still show today as Absent/No Work/On Leave
            # if it's a scheduled day.
            if today in no_work_dates:
                today_status = "No Work"
            elif on_leave_today:
                today_status = "On Leave"
            else:
                today_status = "Absent"
            history.append({
                "attendance_date": today,
                "shift_name": "",
                "time_in": None,
                "time_out": None,
                "status": today_status,
            })

        for h in history:
            h["attendance_date"] = str(h["attendance_date"])

        history.sort(key=lambda r: r["attendance_date"], reverse=True)

        return jsonify({"success": True, "records": history})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500
@attendance_bp.route("/api/employee-groupings")
@login_required
def employee_groupings():
    """
    Full employee roster from frontend.employee_groupings — used by the
    attendance dashboard to merge in position, shift, and active/inactive
    status for every scheduled employee, not just those with a log today.

    Filtered through can_view_employee() (department + line_name/shift)
    before being returned — this endpoint used to hand back every employee
    in the company regardless of who was logged in, which is exactly the
    kind of unfiltered feed the 4-tier access matrix is meant to close off.
    """
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text("""
                SELECT emp_id, emp_no, full_name, position, shift,
                       employee_status, department, line_name, gender
                FROM frontend.employee_groupings
            """)).fetchall()

        records = [dict(r._mapping) for r in rows]
        visible = [
            r for r in records
            if can_view_employee({
                "department": r.get("department", ""),
                "line_name":  r.get("line_name", ""),
                "shift":      r.get("shift", ""),
            })
        ]
        return jsonify(visible)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

@attendance_bp.route("/api/no-work", methods=["GET"])
@login_required
def list_no_work():
    """Reads directly from frontend.no_work_schedule (this app's own DB),
    same as create_no_work()/_fetch_no_work_records() below — no longer
    proxied through the external NO_WORK_BASE_URL service."""
    try:
        target_date = request.args.get("date")

        query = """
            SELECT id, emp_id, line_name, shift, work_date, reason, created_by, created_at
            FROM frontend.no_work_schedule
        """
        params = {}
        if target_date:
            query += " WHERE work_date = :work_date"
            params["work_date"] = target_date
        query += " ORDER BY id ASC"

        with db.engine.connect() as conn:
            rows = conn.execute(sa_text(query), params).fetchall()

        return jsonify([
            {
                "id": r[0],
                "emp_id": r[1],
                "line_name": r[2],
                "shift": r[3],
                "work_date": str(r[4]) if r[4] else None,
                "reason": r[5],
                "created_by": r[6],
                "created_at": str(r[7]) if r[7] else None,
            }
            for r in rows
        ])

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

@attendance_bp.route("/api/no-work/resolved", methods=["GET"])
@login_required
def resolved_no_work():
    """NOTE: still proxies to the external NO_WORK_BASE_URL service,
    unlike list_no_work()/create_no_work()/delete_no_work() above, which
    now read/write frontend.no_work_schedule directly. Whatever "resolved"
    means on the external side, it won't see entries created after this
    change (they only exist in this app's own DB now). Flag if this route
    is actually used anywhere — it isn't called by employee_management.js
    — and it likely needs the same direct-DB treatment, once it's clear
    what a "resolved" no-work entry is meant to represent."""
    try:
        target_date = request.args.get("date")

        res = requests.get(
            NO_WORK_BASE_URL + "/resolved",
            params={"date": target_date},
            timeout=15
        )

        return (
            jsonify(res.json()),
            res.status_code,
        )

    except requests.RequestException as e:
        return jsonify({
            "success": False,
            "message": str(e)
        }), 502

@attendance_bp.route("/api/no-work", methods=["POST"])
@admin_required
def create_no_work():
    """
    Bulk "Mark No Work" for one or more employees on one date.

    CHANGED: previously proxied to the external NO_WORK_BASE_URL /add
    endpoint. That service's field-name expectations for emp_id vs.
    line_name/shift turned out to be inconsistent/undocumented (multiple
    payload shapes were tried; each one only ever populated some of the
    columns correctly). Since frontend.no_work_schedule lives in this
    app's own database (same schema as employee_groupings, confirmed via
    direct SQL), this now inserts into it directly with db.engine —
    same pattern as bulk_leave()/bulk_return() in data.py.

    line_name/shift are resolved per employee from
    frontend.employee_groupings via _fetch_scope_map()/_lookup_scope()
    (same helpers used elsewhere in this file) rather than trusting the
    client, since the frontend (employee_management.js submitNoWork())
    only ever sends {work_date, emp_ids, reason} and has no field for
    these anyway.

    One row is written per employee — an existing row for the same
    emp_id + work_date is left alone and reported back in
    skipped_existing, matching what the frontend already expects.
    """
    try:
        body = request.get_json(force=True, silent=True) or {}

        work_date = body.get("work_date")
        reason = body.get("reason")
        emp_ids = body.get("emp_ids") or []
        created_by = body.get("created_by") or session.get("username", "SYSTEM")

        if not work_date or not emp_ids or not isinstance(emp_ids, list):
            return jsonify({
                "success": False,
                "message": "work_date and a non-empty emp_ids list are required."
            }), 400

        scope_map = _fetch_scope_map()

        inserted = []
        skipped_existing = []
        failures = []

        with db.engine.begin() as conn:
            for emp_id in emp_ids:
                emp_id = str(emp_id).strip().upper()
                if not emp_id:
                    continue

                try:
                    existing = conn.execute(sa_text("""
                        SELECT id FROM frontend.no_work_schedule
                        WHERE emp_id = :emp_id AND work_date = :work_date
                    """), {"emp_id": emp_id, "work_date": work_date}).fetchone()

                    if existing:
                        skipped_existing.append(emp_id)
                        continue

                    scope = _lookup_scope(scope_map, emp_id)

                    conn.execute(sa_text("""
                        INSERT INTO frontend.no_work_schedule
                            (emp_id, line_name, shift, work_date, reason, created_by, created_at)
                        VALUES
                            (:emp_id, :line_name, :shift, :work_date, :reason, :created_by, NOW())
                    """), {
                        "emp_id": emp_id,
                        "line_name": scope.get("line_name") or None,
                        "shift": scope.get("shift") or None,
                        "work_date": work_date,
                        "reason": reason,
                        "created_by": created_by,
                    })
                    inserted.append(emp_id)

                except Exception as row_err:
                    print("NO WORK ROW ERROR:", row_err)
                    failures.append({"emp_id": emp_id, "message": str(row_err)})

        return jsonify({
            "success": not failures,
            "inserted": len(inserted),
            "inserted_ids": inserted,
            "skipped_existing": skipped_existing,
            "failures": failures,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "message": str(e)
        }), 500

@attendance_bp.route("/api/no-work/<int:entry_id>", methods=["DELETE"])
@admin_required
def delete_no_work(entry_id):
    """Deletes directly from frontend.no_work_schedule (this app's own
    DB) — no longer proxied through the external NO_WORK_BASE_URL
    service, matching list_no_work()/create_no_work() above."""
    try:
        with db.engine.begin() as conn:
            result = conn.execute(sa_text("""
                DELETE FROM frontend.no_work_schedule WHERE id = :id
            """), {"id": entry_id})

        if result.rowcount == 0:
            return jsonify({"success": False, "message": "No Work entry not found."}), 404

        return jsonify({"success": True, "id": entry_id, "deleted": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

# ======================================================================

def _apply_attendance_changes(conn, emp_id, emp_no, full_name, position,
                               attendance_date, changes, changed_by):
    """
    Shared insert-or-update + audit-trail logic for writing into
    backend.attendance_logs. Used by both /api/attendance/override and by
    approving a Time-In request at its FINAL (HR) stage — both need to do
    the same "does a row already exist for this emp/date, update it or
    insert one" dance and leave the same audit trail behind, so it's
    factored out here instead of being copy-pasted (and risking the two
    paths silently diverging).

    Raises ValueError on bad input (caller turns that into a 400).
    Returns (old_data, new_data, safe_changes).
    """
    emp_id = str(emp_id or "").strip()
    emp_no = str(emp_no or "").strip() or None
    full_name = str(full_name or "").strip() or None
    attendance_date = str(attendance_date or "").strip()

    safe_changes = {k: v for k, v in (changes or {}).items() if k in EDITABLE_ATTENDANCE_FIELDS}
    if not safe_changes:
        raise ValueError(f"No editable fields provided. Allowed: {sorted(EDITABLE_ATTENDANCE_FIELDS)}")

        conn.execute(sa_text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                 {"k": f"att:{emp_id}|{attendance_date}"})
    existing = conn.execute(sa_text("""
        SELECT emp_id, emp_no, emp_status, attendance_date,
               time_in, time_in_status, time_in_location,
               time_out, time_out_status, time_out_location, shift_name
        FROM backend.attendance_logs
        WHERE emp_id = :emp_id AND attendance_date = :dt
    """), {"emp_id": emp_id, "dt": attendance_date}).fetchone()

    if not existing:
        # No punch on record yet for this employee/date — create the row
        # instead of failing, so this can log someone who is physically
        # present but never scanned.
        if not emp_no:
            raise ValueError("emp_no is required to create a new attendance record.")

        old_data = None
        emp_row = conn.execute(sa_text(
            "SELECT emp FROM frontend.employee_groupings WHERE emp_id = :emp_id LIMIT 1"
        ), {"emp_id": emp_id}).fetchone()

        insert_data = {
            "emp_id": emp_id,
            "emp_no": emp_no,
            "emp": emp_row[0] if emp_row else None,
            "full_name": full_name,
            "attendance_date": attendance_date,
            "time_in": None,
            "time_in_status": None,
            "time_in_location": None,
            "time_out": None,
            "time_out_status": None,
            "time_out_location": None,
            "shift_name": None,
            **safe_changes,
        }
        columns = ", ".join(insert_data.keys())
        placeholders = ", ".join(f":{col}" for col in insert_data.keys())
        conn.execute(sa_text(
            f"INSERT INTO backend.attendance_logs ({columns}) VALUES ({placeholders})"
        ), insert_data)
        new_data = insert_data
        action_type = "INSERT"
        audit_emp_no = emp_no

    else:
        old_data = {
            "emp_id": existing[0], "emp_no": existing[1], "emp_status": existing[2],
            "attendance_date": str(existing[3]) if existing[3] else None,
            "time_in": str(existing[4]) if existing[4] else None,
            "time_in_status": existing[5], "time_in_location": existing[6],
            "time_out": str(existing[7]) if existing[7] else None,
            "time_out_status": existing[8], "time_out_location": existing[9],
            "shift_name": existing[10],
        }
        new_data = {**old_data, **safe_changes}

        set_clause = ", ".join(f"{col} = :{col}" for col in safe_changes)
        conn.execute(sa_text(
            f"UPDATE backend.attendance_logs SET {set_clause} "
            f"WHERE emp_id = :emp_id AND attendance_date = :dt"
        ), {**safe_changes, "emp_id": emp_id, "dt": attendance_date})
        action_type = "UPDATE"
        audit_emp_no = existing[1]

    conn.execute(sa_text("""UPDATE backend.attendance_logs
        SET manual_override=TRUE, matching_status='CONFIRMED', review_reason=NULL,
            matching_method='manual', inferred_shift=shift_name,
            time_in_at=attendance_date + time_in,
            time_out_at=attendance_date + time_out +
              CASE WHEN time_out < time_in OR (time_in IS NULL AND
                   lower(COALESCE(shift_name,'')) LIKE '%night%' AND time_out < TIME '12:00')
                   THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END
        WHERE emp_id=:id AND attendance_date=:day"""), {"id":emp_id,"day":attendance_date})
    conn.execute(sa_text("""UPDATE backend.biometric_logs SET processed=FALSE
        WHERE emp_id=:id
          AND punch_time >= CAST(:day AS date) - 1
          AND punch_time <  CAST(:day AS date) + 2"""),
        {"id": emp_id, "day": attendance_date})

    conn.execute(sa_text("""
        INSERT INTO backend.employee_record_audit
            (emp_id, emp_no, action_type, changed_by, old_data, new_data, changed_at)
        VALUES
            (:emp_id, :emp_no, :action_type, :changed_by, :old_data, :new_data, NOW())
    """), {
        "emp_id":      emp_id,
        "emp_no":      audit_emp_no,
        "action_type": action_type,
        "changed_by":  changed_by,
        "old_data":    json.dumps(old_data),
        "new_data":    json.dumps(new_data),
    })

    return old_data, new_data, safe_changes


@attendance_bp.route("/api/attendance/time-in-request", methods=["POST"])
@line_leader_required
def create_time_in_request():
    """
    User-side submission. Never writes to backend.attendance_logs — inserts
    a row into backend.attendance_time_in_requests with status
    "Pending First Approval", the first stage of the two-stage approval.
    """
    try:
        body            = request.get_json(force=True, silent=True) or {}
        emp_id          = str(body.get("emp_id", "")).strip()
        emp_no          = str(body.get("emp_no", "")).strip() or None
        full_name       = str(body.get("full_name", "")).strip() or None
        position        = str(body.get("position", "")).strip() or None
        attendance_date = str(body.get("attendance_date", "")).strip()
        remarks         = (body.get("remarks") or "").strip() or None
        requested_by    = str(body.get("requested_by", session.get("username", "system"))).strip()
        changes         = body.get("changes", {})

        if not emp_id or not attendance_date:
            return jsonify({"success": False, "message": "emp_id and attendance_date are required."}), 400

        # A Line Leader may submit only for an employee in the leader's
        # assigned line/shift; never trust a client-supplied employee id.
        scope = _lookup_scope(_fetch_scope_map(), emp_id, emp_no)
        if not _user_can_view_request(scope):
            return jsonify({"success": False, "message": "Employee is outside your assigned line."}), 403

        safe_changes = {
            k: v for k, v in (changes or {}).items()
            if k in EDITABLE_ATTENDANCE_FIELDS and v not in (None, "")
        }
        if not safe_changes:
            return jsonify({
                "success": False,
                "message": f"No editable fields provided. Allowed: {sorted(EDITABLE_ATTENDANCE_FIELDS)}",
            }), 400

        with db.engine.begin() as conn:
            row = conn.execute(sa_text("""
                INSERT INTO backend.attendance_time_in_requests
                    (emp_id, emp_no, full_name, position, attendance_date,
                     changes, remarks, requested_by, status, requested_at)
                VALUES
                    (:emp_id, :emp_no, :full_name, :position, :attendance_date,
                     :changes, :remarks, :requested_by, :status, NOW())
                RETURNING request_id
            """), {
                "emp_id": emp_id,
                "emp_no": emp_no,
                "full_name": full_name,
                "position": position,
                "attendance_date": attendance_date,
                "changes": json.dumps(safe_changes),
                "remarks": remarks,
                "requested_by": requested_by,
                "status": TIME_IN_REQUEST_STATUS_PENDING_FIRST,
            }).fetchone()

        return jsonify({"success": True, "request_id": row[0]})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@attendance_bp.route("/api/attendance/time-in-request", methods=["GET"])
@login_required
def list_time_in_requests():
    """Lists Time-In request, optionally filtered by ?status=. Used for both
    the First Approval queue and the HR (final) approval queue, plus their
    header badge counts.

    ACCESS MODEL: this endpoint is open to every logged-in user (no
    admin/HR-only gate on the GET itself) — the Pending HR (Final)
    Approval queue is viewable by everyone now, same as the First
    Approval queue always was. What changes per stage is who can act:
    Approve/Decline is enforced separately in first_approve_time_in_request(),
    approve_time_in_request(), and decline_time_in_request() below.

    Visibility is still scoped by the full 4-tier matrix: each row is
    resolved to a department + line_name + shift via the requesting
    employee's emp_id/emp_no (frontend.employee_groupings) and filtered
    through can_view_employee() — Administration/Admin accounts see every
    department, Department-level accounts see their whole department, and
    Line/Section-level accounts only see request for their own
    line/section. This is the real, server-side version of the same
    filter the frontend JS already applies for UX — without it, a user
    could hit this route directly and read every department's request
    regardless of what the UI shows.
    """
    status_filter = request.args.get("status", "").strip()

    try:
        query = """
            SELECT request_id, emp_id, emp_no, full_name, position,
                   attendance_date, changes, remarks, requested_by,
                   status, requested_at, reviewed_by, reviewed_at,
                   first_approved_by, first_approved_at
            FROM backend.attendance_time_in_requests
        """
        params = {}
        if status_filter:
            query += " WHERE status = :status"
            params["status"] = status_filter
        query += " ORDER BY requested_at DESC"

        with db.engine.connect() as conn:
            rows = conn.execute(sa_text(query), params).fetchall()

        scope_map = _fetch_scope_map()
        name_map = _fetch_user_name_map()

        requests_out = []
        for r in rows:
            scope = _lookup_scope(scope_map, r[1], r[2])  # emp_id, emp_no
            department = scope["department"]

            if not _user_can_view_request(scope):
                continue

            changes = r[6]
            if isinstance(changes, str):
                try:
                    changes = json.loads(changes)
                except (TypeError, ValueError):
                    changes = {}

            requested_by_username = r[8]
            requester_name = name_map.get(str(requested_by_username or "").strip(), {})

            first_approved_by_username = r[13]
            first_approver_name = name_map.get(str(first_approved_by_username or "").strip(), {})

            requests_out.append({
                "id": r[0],
                "emp_id": r[1],
                "emp_no": r[2],
                "full_name": r[3],
                "position": r[4],
                "department": department,
                "attendance_date": str(r[5]) if r[5] else None,
                "changes": changes or {},
                "remarks": r[7],
                "requested_by": requested_by_username,
                "requested_by_first_name": requester_name.get("first_name"),
                "requested_by_last_name": requester_name.get("last_name"),
                "status": r[9],
                "requested_at": str(r[10]) if r[10] else None,
                "reviewed_by": r[11],
                "reviewed_at": str(r[12]) if r[12] else None,
                "first_approved_by": first_approved_by_username,
                "first_approved_by_first_name": first_approver_name.get("first_name"),
                "first_approved_by_last_name": first_approver_name.get("last_name"),
                "first_approved_at": str(r[14]) if r[14] else None,
            })

        return jsonify({"success": True, "request": requests_out})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


@attendance_bp.route("/api/attendance/time-in-request/<int:request_id>/first-approve", methods=["PUT"])
@level_2_to_4_required
def first_approve_time_in_request(request_id: int):
    """
    STAGE 1 of 2. Records who signed off first and advances the request
    from "Pending First Approval" to "Pending HR Approval". Does NOT touch
    backend.attendance_logs — only the final HR approval
    (approve_time_in_request, below) writes the change through.

    Authorization: gated by the full 4-tier matrix via
    _user_can_view_request() — a Line/Section-level account may only
    first-approve request for their own line/section, a Department-level
    account for their whole department, and Administration/Admin accounts
    are unrestricted.
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
        first_approved_by = str(body.get("first_approved_by", session.get("username", "system"))).strip()

        with db.engine.begin() as conn:
            req_row = conn.execute(sa_text("""
                SELECT status, emp_id, emp_no FROM backend.attendance_time_in_requests
                WHERE request_id = :id
                FOR UPDATE
            """), {"id": request_id}).fetchone()

            if not req_row:
                return jsonify({"success": False, "message": "Request not found."}), 404

            status, emp_id, emp_no = req_row

            if status != TIME_IN_REQUEST_STATUS_PENDING_FIRST:
                return jsonify({
                    "success": False,
                    "message": f"Request is {status}; it is not awaiting first approval.",
                }), 409

            scope_map = _fetch_scope_map()
            scope = _lookup_scope(scope_map, emp_id, emp_no)
            if not _user_can_view_request(scope):
                return jsonify({
                    "success": False,
                    "message": "You are not authorized to approve request for this department.",
                }), 403

            conn.execute(sa_text("""
                UPDATE backend.attendance_time_in_requests
                SET status = :status, first_approved_by = :first_approved_by, first_approved_at = NOW()
                WHERE request_id = :id
            """), {
                "status": TIME_IN_REQUEST_STATUS_PENDING_HR,
                "first_approved_by": first_approved_by,
                "id": request_id,
            })

        return jsonify({"success": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@attendance_bp.route("/api/attendance/time-in-request/<int:request_id>/approve", methods=["PUT"])
@level_2_to_4_required
def approve_time_in_request(request_id: int):
    """
    STAGE 2 of 2 — the FINAL/HR approval. Only allowed once a request has
    already cleared Stage 1 (status == "Pending HR Approval"). Writes the
    request's stored `changes` into backend.attendance_logs (same
    insert-or-update + audit trail as /api/attendance/override) and flips
    the request's own status to "Approved". The live attendance record is
    only ever touched here — never at submission, never at Stage 1.

    Gated by @hr_approval_required (Admin role OR Administration
    department) instead of the old @admin_required — Admin-role-only would
    have wrongly blocked Administration-department accounts, which are
    also meant to have unrestricted final-approval access.
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
        reviewed_by = str(body.get("reviewed_by", session.get("username", "system"))).strip()

        with db.engine.begin() as conn:
            req_row = conn.execute(sa_text("""
                SELECT emp_id, emp_no, full_name, position, attendance_date, changes, status
                FROM backend.attendance_time_in_requests
                WHERE request_id = :id
                FOR UPDATE
            """), {"id": request_id}).fetchone()

            if not req_row:
                return jsonify({"success": False, "message": "Request not found."}), 404

            emp_id, emp_no, full_name, position, attendance_date, changes, status = req_row

            if status != TIME_IN_REQUEST_STATUS_PENDING_HR:
                return jsonify({
                    "success": False,
                    "message": f"Request is {status}; it must complete first approval before HR can give final approval.",
                }), 409

            if isinstance(changes, str):
                changes = json.loads(changes) if changes else {}

            try:
                old_data, new_data, applied = _apply_attendance_changes(
                    conn, emp_id, emp_no, full_name, position,
                    str(attendance_date), changes or {}, reviewed_by,
                )
            except ValueError as ve:
                return jsonify({"success": False, "message": str(ve)}), 400

            conn.execute(sa_text("""
                UPDATE backend.attendance_time_in_requests
                SET status = :status, reviewed_by = :reviewed_by, reviewed_at = NOW()
                WHERE request_id = :id
            """), {
                "status": TIME_IN_REQUEST_STATUS_APPROVED,
                "reviewed_by": reviewed_by,
                "id": request_id,
            })

        return jsonify({
            "success": True,
            "fields_updated": list(applied.keys()),
            "old_data": old_data,
            "new_data": new_data,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@attendance_bp.route("/api/attendance/time-in-request/<int:request_id>/decline", methods=["PUT"])
@level_2_to_4_required
def decline_time_in_request(request_id: int):
    """Leaves backend.attendance_logs untouched — only the request's own
    status changes, to "Declined". Allowed from either pending stage
    (first approval or HR/final approval).

    Authorization depends on which stage the request is currently in
    (checked server-side against the row's live status, not whatever the
    client claims):
      - Pending First Approval -> same rule as first-approve: gated by the
        full 4-tier matrix via _user_can_view_request() (Line/Section's
        own scope, Department's own department, or Administration/Admin
        unrestricted).
      - Pending HR Approval -> HR only (Admin role or Administration
        department), same gate as the final approve.
    This replaces the previous @admin_required, which incorrectly blocked
    every non-Admin department lead from declining their own department's
    Stage-1 request.
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
        reviewed_by = str(body.get("reviewed_by", session.get("username", "system"))).strip()

        with db.engine.begin() as conn:
            req_row = conn.execute(sa_text("""
                SELECT status, emp_id, emp_no FROM backend.attendance_time_in_requests
                WHERE request_id = :id
                FOR UPDATE
            """), {"id": request_id}).fetchone()

            if not req_row:
                return jsonify({"success": False, "message": "Request not found."}), 404

            status, emp_id, emp_no = req_row

            if status not in (TIME_IN_REQUEST_STATUS_PENDING_FIRST, TIME_IN_REQUEST_STATUS_PENDING_HR):
                return jsonify({
                    "success": False,
                    "message": f"Request is already {status}; it cannot be declined again.",
                }), 409

            if status == TIME_IN_REQUEST_STATUS_PENDING_FIRST:
                scope_map = _fetch_scope_map()
                scope = _lookup_scope(scope_map, emp_id, emp_no)
                authorized = _user_can_view_request(scope)
            else:
                # The decorator-level rule for this endpoint is evaluated
                # here because the allowed action depends on the stored
                # request stage.  Levels 2-4 may review either stage.
                authorized = (
                    (session.get("access_level") or "").strip().upper()
                    in {"SECTION", "DEPARTMENT", "GLOBAL"}
                    or session.get("role") == "Admin"
                )

            if not authorized:
                return jsonify({
                    "success": False,
                    "message": "You are not authorized to decline this request.",
                }), 403

            conn.execute(sa_text("""
                UPDATE backend.attendance_time_in_requests
                SET status = :status, reviewed_by = :reviewed_by, reviewed_at = NOW()
                WHERE request_id = :id
            """), {
                "status": TIME_IN_REQUEST_STATUS_DECLINED,
                "reviewed_by": reviewed_by,
                "id": request_id,
            })

        return jsonify({"success": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500
@attendance_bp.route("/api/attendance-history/bulk", methods=["POST"])
@login_required
def attendance_history_bulk():
    """
    Bulk version of /api/attendance-history/<emp_id>. Same exact status
    rules (No Work / On Leave / Absent Mon-Sat backfill) as that route,
    but computed for many employees in ONE pass instead of the
    per-employee endpoint doing its own full attendance-logs fetch +
    no-work/leave DB query for every single employee. Callers that used
    to hit attendance_history() once per employee (e.g. a "Top 5 Most
    Present" widget looping over 300-400 employees) should call this once
    instead with all the ids they need.

    Request body:  {"emp_ids": ["1001", "N-2002", ...]}
    Response:      {"success": true, "results": {"<normalized_id>": [ ...same row shape as attendance_history()... ]}}

    Keys in "results" use the SAME normalization attendance_history()
    applies internally (uppercased, any prefix before "-" stripped), so
    callers should normalize their own ids the same way before looking
    up the response (strip to upper case, drop everything before the
    first "-").
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
        raw_ids = body.get("emp_ids") or []
        if not isinstance(raw_ids, list) or not raw_ids:
            return jsonify({"success": False, "message": "emp_ids must be a non-empty list."}), 400

        targets = set()
        for raw in raw_ids:
            t = str(raw).strip().upper()
            if "-" in t:
                t = t.split("-", 1)[1]
            if t:
                targets.add(t)

        if not targets:
            return jsonify({"success": False, "message": "No valid emp_ids provided."}), 400

        # Fetch everything ONCE instead of once per employee.
        from routes.data import is_in_todays_window
        records = _fetch_history_records()
        shift_map = _fetch_shift_map()
        all_no_work_records = _fetch_no_work_records()   # every date/employee, one query
        leave_employees = _fetch_leave_employees()        # one query

        # Group No Work dates by employee (same normalization as _no_work_key()).
        no_work_by_emp = {}
        for r in all_no_work_records:
            if not isinstance(r, dict):
                continue
            key = _no_work_key(r)
            if not key:
                continue
            d = _parse_no_work_date(
                r.get("work_date") or r.get("date") or r.get("no_work_date") or r.get("attendance_date", "")
            )
            if d:
                no_work_by_emp.setdefault(key, set()).add(d)

        # Group attendance-log rows by employee, one pass over the feed
        # instead of one full scan per employee.
        records_by_emp = {}
        for record in records:
            if not is_valid_employee_record(record):
                continue
            # FIX: group by the main table's key (record_emp_key), not emp_no,
            # so agency ids ("N12") match and THN "12" no longer absorbs
            # agency rows that share emp_no "12".
            row_key = _history_row_key(record)
            for t in targets:
                if row_key == t.replace("-", ""):
                    records_by_emp.setdefault(t, []).append(record)
                    break

        today = date.today()
        one_day = timedelta(days=1)
        results = {}

        for target in targets:
            no_work_dates = no_work_by_emp.get(target, set())
            on_leave_today = target in leave_employees

            history = []
            covered_today = False
            now_t = datetime.now().time()
            for record in records_by_emp.get(target, []):
                att_date = parse_date(record.get("attendance_date", ""))
                if att_date is None:
                    continue
                raw_shift = str(record.get("shift_name") or "").strip()
                shift_name = raw_shift or _lookup_shift(shift_map, record.get("emp_id"), target)
                time_in = record.get("time_in")
                time_in = time_in if is_valid_checkin(time_in) else None

                if att_date in no_work_dates:
                    row_status = "No Work"
                elif att_date == today and on_leave_today:
                    row_status = "On Leave"
                else:
                    row_status = determine_roster_status(shift_name, time_in)

                history.append({
                    "attendance_date": att_date,
                    "shift_name": shift_name,
                    "time_in": time_in,
                    "time_out": record.get("time_out"),
                    "status": "Needs Review" if record.get("matching_status") == "NEEDS_REVIEW" else row_status,
                })

                if att_date != today and is_in_todays_window(
                    str(record.get("attendance_date", "")).strip(),
                    record.get("inferred_shift") or shift_name,
                    today, now_t,
                ):
                    covered_today = True

            # --- same Mon-Sat gap backfill as attendance_history() ---
            if history:
                existing_dates = {h["attendance_date"] for h in history}
                start = min(existing_dates)
                end = max(max(existing_dates), today)

                cursor = start
                while cursor <= end:
                    if (cursor.weekday() != 6 and cursor not in existing_dates   # skip Sunday
                            and not (cursor == today and covered_today)):
                        if cursor in no_work_dates:
                            gap_status = "No Work"
                        elif cursor == today and on_leave_today:
                            gap_status = "On Leave"
                        else:
                            gap_status = "Absent"
                        history.append({
                            "attendance_date": cursor,
                            "shift_name": "",
                            "time_in": None,
                            "time_out": None,
                            "status": gap_status,
                        })
                    cursor += one_day
            elif today.weekday() != 6:
                if today in no_work_dates:
                    today_status = "No Work"
                elif on_leave_today:
                    today_status = "On Leave"
                else:
                    today_status = "Absent"
                history.append({
                    "attendance_date": today,
                    "shift_name": "",
                    "time_in": None,
                    "time_out": None,
                    "status": today_status,
                })

            for h in history:
                h["attendance_date"] = str(h["attendance_date"])

            history.sort(key=lambda r: r["attendance_date"], reverse=True)
            results[target] = history

        return jsonify({"success": True, "results": results})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500