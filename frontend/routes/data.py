import json
from flask import Blueprint, request, jsonify, session
from sqlalchemy import text as sa_text
from datetime import date, datetime, timedelta, time as dtime
import traceback
import re
import os
import threading
from routes.attendance import is_valid_employee_record
from routes.extensions import db
from routes.decorators import login_required, level_2_to_4_required, line_leader_required
from routes.auth import can_view_employee, can_view_group, hr_approval_required, role_context
from .groupings import apply_due_imports
from .http_client import get_json, attendance_window_url
from routes.emp_id import build_emp_id, agency_code_from_emp_id
from routes.auth import _extract_line_key, parse_employee_department, LINE_LEVEL_DEPARTMENTS

def current_username() -> str:
    """Returns the logged-in user's display name for audit columns like
    `created_by`, derived from the server-side session (never trust a
    client-supplied value for this -- it's easily spoofed). Falls back to
    "SYSTEM" only if somehow called outside an authenticated session.
    """
    first_name = (session.get("first_name") or "").strip()
    last_name = (session.get("last_name") or "").strip()
    full_name = f"{first_name} {last_name}".strip()
    return full_name or (session.get("username") or "SYSTEM")


# These assignments intentionally live outside employee_groupings: a line
# transition is a shift-only coverage decision, never a permanent roster move.
def _ensure_line_transition_table(conn) -> None:
    conn.execute(sa_text("""
        CREATE TABLE IF NOT EXISTS frontend.line_transition_history (
            id BIGSERIAL PRIMARY KEY,
            transition_date DATE NOT NULL DEFAULT CURRENT_DATE,
            target_line TEXT NOT NULL,
            target_process TEXT NOT NULL,
            original_employee_id TEXT,
            original_employee_name TEXT,
            replacement_employee_id TEXT NOT NULL,
            replacement_employee_name TEXT NOT NULL,
            replacement_line TEXT,
            replacement_process TEXT,
            transition_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'transitioned',
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    # shift_type / shift_date let a night-shift transition survive past
    # midnight (see _shift_business_date). Old rows have NULL shift_date and
    # fall back to transition_date, so nothing existing breaks.
    conn.execute(sa_text("ALTER TABLE frontend.line_transition_history "
                         "ADD COLUMN IF NOT EXISTS shift_type TEXT NOT NULL DEFAULT 'day'"))
    conn.execute(sa_text("ALTER TABLE frontend.line_transition_history "
                         "ADD COLUMN IF NOT EXISTS shift_date DATE"))
    conn.execute(sa_text("""
        CREATE TABLE IF NOT EXISTS frontend.line_process_status_history (
            status_date DATE NOT NULL DEFAULT CURRENT_DATE,
            target_line TEXT NOT NULL,
            target_process TEXT NOT NULL,
            employee_id TEXT NOT NULL,
            employee_name TEXT NOT NULL,
            status TEXT NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (status_date, target_line, target_process, employee_id)
        )
    """))


def _line_transition_access(raw_line: str):
    """Return the canonical line or a JSON 403 response for another line."""
    line = _extract_line_key((raw_line or "").strip().upper())
    role = role_context().get("role_info", {})
    if role.get("access_level") == "LINE" and not role.get("is_admin"):
        assigned = _extract_line_key((role.get("assigned_line") or "").strip().upper())
        if not line or line != assigned:
            return None
    return line

data_bp = Blueprint("data", __name__)


ATTENDANCE_LOGS_URL = "http://192.9.224.6:5000/attendance/attendance-logs"
EMPLOYEES_URL       = "http://192.9.224.6:5000/employee_groupings"
ALLOWED_DEPARTMENTS = {"production", "quality", "technical", "assembly"}
INVALID_CHECKIN     = {"", "-", "none", "null", "no check-in yet", "n/a", "na"}

# Night shift: 7:00 PM -> 4:00 AM next morning, with overtime allowed up to
# 7:00 AM. Everything that belongs to a night shift (attendance window,
# temporary transitions/assignments) stays alive until NIGHT_SHIFT_OT_END and
# only then rolls over to the next shift date.
NIGHT_SHIFT_START   = dtime(19, 0, 0)
NIGHT_SHIFT_END     = dtime(4, 0, 0)
NIGHT_SHIFT_OT_END  = dtime(7, 0, 0)


def _normalize_shift_type(value) -> str:
    """'night' for any night-shift label (Night Shift, NS, L2 NS ...), else 'day'."""
    text = str(value or "").strip().upper()
    if not text:
        return "day"
    is_night = "NIGHT" in text or re.search(r"\bNS\b", text) is not None
    is_day = "DAY" in text or re.search(r"\bDS\b", text) is not None
    return "night" if is_night and not is_day else "day"


def _shift_business_date(shift_type: str, now: datetime = None) -> date:
    """The 'shift date' a transition/assignment belongs to.

    Day shift  -> the calendar date.
    Night shift -> the date the shift STARTED. Between 12:00 AM and 7:00 AM
    (the 4 AM end + overtime) we are still inside last evening's shift, so the
    shift date is yesterday. That is why assignments no longer disappear at
    midnight and only reset once the night shift (and its OT) is over.
    """
    now = now or datetime.now()
    if _normalize_shift_type(shift_type) == "night" and now.time() < NIGHT_SHIFT_OT_END:
        return now.date() - timedelta(days=1)
    return now.date()
# Agency int FK -> display name, used only by attendance-analytics'
# "agency" dimension grouping (keyed off employee_groupings.emp, not emp_id).
AGENCY_NAME_BY_ID = {1: "THN", 2: "CCI", 3: "NATCORP", 4: "EMIS"}

# Minimum gap required between two 'rehired' events for the same employee
# before a new one is allowed to be logged. Approximates "two months" as a
# fixed day count rather than calendar months, to keep the check simple.
REHIRE_COOLDOWN_DAYS = 90

LEAVE_REMARK_CODES = {"VL", "SL", "ML", "SS", "PL"}


# ── Leave remark formats ────────────────────────────────────────────────
#   "VL [2026-10-05] - fever"                 -> leave on 2026-10-05 only
#   "VL [2026-10-05 to 2026-10-07] - fever"   -> leave from 10-05 through 10-07
#   "ON LEAVE | Reason: x | Until: 2026-10-07" (bulk-leave) -> through 10-07
#   "ON LEAVE | Reason: x"                    -> open-ended, ends via bulk-return
#   "VL - fever" (OLD format, no dates)       -> valid only on the day it was set
LEAVE_CODE_RE = re.compile(
    r"^(VL|SL|ML|SS|PL)(?:\s*\[\s*(\d{4}-\d{2}-\d{2})(?:\s*to\s*(\d{4}-\d{2}-\d{2}))?\s*\])?(?:[\s-]|$)",
    re.IGNORECASE,
)
LEAVE_UNTIL_RE = re.compile(r"Until:\s*(\d{4}-\d{2}-\d{2})", re.IGNORECASE)


def _iso_to_date(value):
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _as_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


def is_leave_remark(remark: str) -> bool:
    clean = (remark or "").strip()
    return bool(LEAVE_CODE_RE.match(clean)) or clean.upper().startswith("ON LEAVE")


def is_leave_remark_active(remark: str, today=None, updated_at=None) -> bool:
    """True if this leave remark still covers `today`."""
    today = today or date.today()
    clean = (remark or "").strip()

    m = LEAVE_CODE_RE.match(clean)
    if m:
        start = _iso_to_date(m.group(2))
        end = _iso_to_date(m.group(3)) or start
        if start:
            return start <= today <= end
        # OLD undated code: only valid on the day it was saved. If we can't
        # tell when it was saved, keep it active rather than guess.
        set_on = _as_date(updated_at)
        return set_on is None or set_on >= today

    if clean.upper().startswith("ON LEAVE"):
        u = LEAVE_UNTIL_RE.search(clean)
        until = _iso_to_date(u.group(1)) if u else None
        return until is None or today <= until

    return False


def classify_remark_status(remark: str, fallback_status: str, time_in=None,
                           updated_at=None, today=None) -> str:
    remark_clean = (remark or "").strip()
    if not remark_clean:
        return fallback_status
    if is_leave_remark(remark_clean):
        # May time-in = pumasok na, hindi on leave (present/late ang lalabas).
        if is_valid_checkin(time_in):
            return fallback_status
        # Active pa ang leave -> on leave. Expired na -> normal na computation
        # (absent kung wala pa ring time-in).
        if is_leave_remark_active(remark_clean, today, updated_at):
            return "on leave"
        return fallback_status
    return "absent"


# ── Auto-clear: pag nag time-in na ang empleyado, buburahin ang leave remark ──
# Alisin sa set na ito ang code na ayaw mong ma-auto-clear (halimbawa "SS"
# kung gusto mong manatili ang suspension record kahit may punch).
AUTO_CLEAR_LEAVE_ON_TIME_IN = {"VL", "SL", "ML", "SS", "PL", "ON LEAVE"}


def should_auto_clear_leave(remark: str, today=None) -> bool:
    """Leave remark na dapat burahin kapag may time-in na ngayon.
    Hindi binubura ang leave na magsisimula pa lang sa future date."""
    today = today or date.today()
    clean = (remark or "").strip()
    m = LEAVE_CODE_RE.match(clean)
    if m:
        if m.group(1).upper() not in AUTO_CLEAR_LEAVE_ON_TIME_IN:
            return False
        start = _iso_to_date(m.group(2))
        return not (start and start > today)
    if clean.upper().startswith("ON LEAVE"):
        return "ON LEAVE" in AUTO_CLEAR_LEAVE_ON_TIME_IN
    return False


def _auto_clear_leave_remarks(pending: dict) -> None:
    """pending = {emp_id: remark_na_nakita}. Compare-and-set: binubura lang kung
    pareho pa rin ang remark sa DB (hindi mabubura ang bagong save ng leader
    na nangyari habang ina-assemble ang response). Hindi dapat mag-fail ang
    dashboard kapag pumalpak ito."""
    try:
        with db.engine.begin() as conn:
            for emp_id, seen_remark in pending.items():
                result = conn.execute(sa_text("""
                    UPDATE frontend.employee_groupings
                    SET remarks = NULL, updated_at = NOW()
                    WHERE emp_id = :emp_id AND remarks = :seen
                """), {"emp_id": emp_id, "seen": seen_remark})
                if result.rowcount:
                    print(f"AUTO-CLEAR LEAVE: {emp_id} (was: {seen_remark!r})")
    except Exception as e:
        print("AUTO-CLEAR LEAVE ERROR:", e)
def is_valid_checkin(value: object) -> bool:
    if not value:
        return False
    return str(value).strip().lower() not in INVALID_CHECKIN


def is_admin_employee(emp: dict) -> bool:
    dept = str(emp.get("department", "") or "").strip().lower()
    return bool(dept) and dept not in ALLOWED_DEPARTMENTS


def normalize_id(value: object) -> str:
    s = str(value or "").strip()
    if s.endswith(".0") and s[:-2].isdigit():
        return s[:-2]
    return s


def build_prefixed_id(raw_emp_no: object, agency_field: object) -> str:
    """
    Turns a raw scanner/master emp_no ("12") into the globally-unique,
    agency-prefixed emp_id ("12" for THN, "N12" for NATCORP, ...), the
    same format used as the primary key in frontend.employee_groupings.
    Prefix mapping lives in routes.emp_id (single source of truth).
    """
    raw_id = normalize_id(raw_emp_no)
    if not raw_id:
        return ""

    if agency_field is None:
        agency_field = ""
    elif isinstance(agency_field, str) and agency_field.strip().isdigit():
        agency_field = int(agency_field.strip())

    return build_emp_id(agency_field, raw_id)
def record_emp_key(record: dict) -> str:
    """
    Susi ng empleyado mula sa isang ATTENDANCE record.

    Kapag may `emp` (agency) ang record, gamitin ang normal na
    build_prefixed_id. Kapag NULL ang `emp` (hal. row na ginawa ng
    approval, hindi ng biometric), ang `emp_id` ng record na mismo ang
    gamitin kasi may prefix na iyon ("N362"). Kung wala rin, balik sa
    dating behavior.
    """
    emp = record.get("emp")
    if emp in (None, ""):
        raw = str(record.get("emp_id") or "").strip().upper()
        if raw:
            return raw
    return build_prefixed_id(record.get("emp_no", ""), emp)

# ── Agency → direct THN transfer de-duplication ─────────────────────────────
# Kapag ang isang agency worker (hal. "N12") ay naging direct THN (bagong ID,
# hal. "4587"), dalawang row na ang nasa employee_groupings para sa iisang
# tao. Itinatago natin ang LUMANG agency row kapag may THN row na kapareho ng
# pangalan. Read-only ito: walang binubura sa database.
# Ilagay sa True kung gusto mong tumugma lang kapag pareho rin ang line_name
# (mas mahigpit, mas kaunti ang false match pero maaaring may matirang doble
# kapag lumipat din ng line ang empleyado).
TRANSFER_DEDUPE_REQUIRE_SAME_LINE = False


def _person_name_key(name: object) -> str:
    # Hindi apektado ng pagkakasunod-sunod, comma, o spaces:
    # "DELA CRUZ, JUAN" == "Juan Dela Cruz"
    tokens = re.findall(r"[A-Z0-9Ñ]+", str(name or "").upper())
    return " ".join(sorted(tokens))


def _is_direct_thn_row(row) -> bool:
    return agency_code_from_emp_id(str(row["emp_id"] or "").strip().upper()) == "THN"


def dedupe_transferred_rows(rows):
    rows = list(rows)
    by_name: dict[str, list] = {}
    for r in rows:
        key = _person_name_key(r["full_name"])
        if key:
            by_name.setdefault(key, []).append(r)

    drop: set[int] = set()
    for members in by_name.values():
        if len(members) < 2:
            continue
        direct = [m for m in members if _is_direct_thn_row(m)]
        if not direct:
            continue  # walang THN row, hindi ito kaso ng transfer
        direct_lines = {str(m["line_name"] or "").strip().upper() for m in direct}
        for m in members:
            if _is_direct_thn_row(m):
                continue
            if TRANSFER_DEDUPE_REQUIRE_SAME_LINE and \
                    str(m["line_name"] or "").strip().upper() not in direct_lines:
                continue
            drop.add(id(m))

    return [r for r in rows if id(r) not in drop]


def parse_date(value: object):
    for fmt in ("%Y-%m-%d", "%a, %d %b %Y %H:%M:%S GMT"):
        try:
            return datetime.strptime(str(value).strip(), fmt).date()
        except Exception:
            pass
    return None


def _tenure_band(value: object) -> str:
    """Turn varying spreadsheet tenure values into stable chart categories."""
    try:
        years = float(value)
    except (TypeError, ValueError):
        return "Not specified"
    if years < 1:
        return "< 1 year"
    if years < 3:
        return "1–3 years"
    if years < 5:
        return "3–5 years"
    return "5+ years"


def _analytics_dimension_value(employee: dict, dimension: str) -> str:
    if dimension == "agency":
        return AGENCY_NAME_BY_ID.get(employee.get("emp"), "Unknown")
    if dimension == "tenure":
        return _tenure_band(employee.get("tenure"))
    if dimension == "department":
        return str(employee.get("department") or "Not specified").strip() or "Not specified"
    if dimension == "line":
        return str(employee.get("line_name") or employee.get("line") or "Unassigned").strip() or "Unassigned"
    return "Unknown"


def is_in_todays_window(att_date_str: str, shift_name: str, today: date, now: dtime) -> bool:
    try:
        att_date = datetime.strptime(att_date_str.strip(), "%Y-%m-%d").date()
    except (ValueError, AttributeError):
        return False
    if att_date == today:
        return True
    is_night = "night" in (shift_name or "").lower()
    return is_night and att_date == today - timedelta(days=1) and now <= NIGHT_SHIFT_OT_END


def _fetch_time_in_map() -> dict:
    from routes.attendance import is_valid_employee_record

    try:
        records = (get_json(attendance_window_url(ATTENDANCE_LOGS_URL), default={}) or {}).get("data", [])
    except Exception as e:
        print("ATTENDANCE LOGS (time_in) ERROR:", e)
        return {}

    today, now = date.today(), datetime.now().time()
    time_in_map: dict[str, str] = {}

    for record in records:
        if not is_valid_employee_record(record):
            continue
        emp_id = record_emp_key(record)
        att_date   = str(record.get("attendance_date", "")).strip()
        shift_name = record.get("shift_name", "")
        if not emp_id or not is_in_todays_window(att_date, shift_name, today, now):
            continue
        time_in_map[emp_id] = record.get("time_in")

    return time_in_map


@data_bp.route("/api/data")
@login_required
def data():
    with db.engine.begin() as conn:
        apply_due_imports(conn)
    from routes.attendance import is_valid_employee_record, determine_roster_status

    # ── Employee master (name/agency/department fallback only — NOT a filter) ──
    try:
        master_employees = get_json(EMPLOYEES_URL, ttl=30, default=[]) or []
    except Exception as e:
        print("EMPLOYEE API ERROR:", e)
        master_employees = []

    master_map: dict[str, dict] = {}
    for emp in master_employees:
        try:
            emp_id = build_prefixed_id(emp.get("emp_no", ""), emp.get("emp"))
            if not emp_id:
                continue
            full_name = emp.get("full_name") or " ".join(filter(None, [
                emp.get("first_name", ""), emp.get("last_name", "")
            ]))
            master_map[emp_id] = {
                "id": emp_id,
                "name": full_name,
                "agency": agency_code_from_emp_id(emp_id),
                "department": emp.get("department") or "",
                "remarks": emp.get("remarks") or "",
                "gender": emp.get("gender") or "",
            }
        except Exception as e:
            print("MASTER EMP ERROR:", e)

    # ── Today's attendance, keyed by prefixed emp_id ──
    try:
        log_records = (get_json(attendance_window_url(ATTENDANCE_LOGS_URL), default={}) or {}).get("data", [])
    except Exception as e:
        print("ATTENDANCE LOGS ERROR:", e)
        log_records = []

    today, now = date.today(), datetime.now().time()

    attendance_map: dict[str, dict] = {}
    for record in log_records:
        try:
            if not is_valid_employee_record(record):
                continue
            emp_id = record_emp_key(record)
            if not emp_id:
                continue
            # Kung may nauna nang record na may valid na time_in, itago iyon.
            # Kung wala pang valid na time_in, payagan ang mas bagong record na palitan.
            if emp_id in attendance_map and (
                attendance_map[emp_id]["time_in"] is not None
                or not is_valid_checkin(record.get("time_in"))
            ):
                continue

            att_date_str = str(record.get("attendance_date", "")).strip()
            shift_name   = record.get("shift_name", "")
            if not is_in_todays_window(att_date_str, shift_name, today, now):
                continue

            time_in = record.get("time_in")
            attendance_map[emp_id] = {
                "time_in":    time_in if is_valid_checkin(time_in) else None,
                "attendance_date": att_date_str,
                "shift_name": shift_name,
                "full_name":  str(record.get("full_name", "")).strip(),
                "review_reason": record.get("review_reason"),
                "matching_status": record.get("matching_status"),
            }
        except Exception as e:
            print("ATTENDANCE LOG ROW ERROR:", e)

    # ── Roster (employee_groupings) ──
    with db.engine.connect() as conn:
        groupings = conn.execute(sa_text("""
            SELECT emp_id, emp_no, full_name, emp, process, line_name, shift, remarks,
                   updated_at,
                   department, gender, position, machine, wing
            FROM frontend.employee_groupings
            WHERE COALESCE(employee_status, 'ACTIVE') <> 'INACTIVE'
        """)).mappings().all()
        inactive_rows = conn.execute(sa_text("""
            SELECT emp_id, emp_no, emp
            FROM frontend.employee_groupings
            WHERE employee_status = 'INACTIVE'
        """)).mappings().all()
    groupings = dedupe_transferred_rows(groupings)  # itago ang lumang agency row ng mga lumipat sa THN

    # Mga INACTIVE (resigned / napalitan ng bagong ID): kung may punch pa sila
    # sa lumang ID, hindi sila dapat lumabas sa Unassigned bilang "taong hindi
    # kilala". Ginagamit sa Unassigned bucket sa ibaba.
    inactive_ids: set[str] = set()
    for r in inactive_rows:
        raw_id = str(r["emp_id"] or "").strip().upper()
        if raw_id:
            inactive_ids.add(raw_id)
        prefixed_id = build_prefixed_id(r["emp_no"] or r["emp_id"], r["emp"])
        if prefixed_id:
            inactive_ids.add(prefixed_id)

    def is_admin_department(department) -> bool:
        dept = str(department or "").strip().lower()
        return dept == "administration"

    admin_ids: set[str] = {
        emp_id for emp_id, att in attendance_map.items()
        if is_admin_department((master_map.get(emp_id) or {}).get("department"))
    }

    auto_clear_leaves: dict[str, str] = {}   # emp_id -> remark na buburahin

    def build_employee(g) -> dict:
        emp_id    = str(g["emp_id"]).strip().upper()
        lookup_id = build_prefixed_id(g["emp_no"] or emp_id, g["emp"]) or emp_id

        attendance = attendance_map.get(lookup_id)
        master     = master_map.get(lookup_id)

        time_in = attendance["time_in"] if attendance else None
        # Visibility and station membership follow the roster. Inferred
        # attendance is evidence, not an authorization or assignment change.
        shift_name = attendance["shift_name"] if attendance else (g["shift"] or "")
        roster_shift = (g["shift"] or "").strip()

        remarks = str(g.get("remarks") or "").strip()

        # CHANGED: was `status = "on leave" if remarks else determine_roster_status(...)`.
        # Now VL/SL/ML -> on leave, other non-empty remarks -> absent, empty -> normal calc.
        fallback_status = determine_roster_status(shift_name, time_in).lower()
        status = classify_remark_status(
            remarks, fallback_status,
            time_in=time_in, updated_at=g.get("updated_at"),
        )

        # AUTO-CLEAR: may valid time-in NGAYON (attendance_date == today, para
        # hindi madale ng night-shift record kahapon) + leave remark -> burahin
        # ang remark, tapos na ang leave niya.
        if (
            is_valid_checkin(time_in)
            and attendance
            and _iso_to_date(attendance.get("attendance_date")) == today
            and should_auto_clear_leave(remarks, today)
        ):
            auto_clear_leaves[g["emp_id"]] = g.get("remarks")
            remarks = ""

        name        = g["full_name"] or (master["name"] if master else "") \
                      or (attendance["full_name"] if attendance else "") or "Unknown"

        department = str(g.get("department") or (master["department"] if master else "") or "").strip()
        gender = str(g.get("gender") or (master["gender"] if master else "") or "").strip()

        return {
            "id": emp_id,
            "name": name,
            "agency": (master["agency"] if master else None) or agency_code_from_emp_id(emp_id),
            "department": department,
            "gender": gender,
            "line_name": g["line_name"] or "",
            "section": g["process"] or "",
            "process": g["process"] or "",
            "position": g["position"] or "",
            "machine": g["machine"] or "",
            "wing": g["wing"] or "",
            "shift": roster_shift,
            "attendance_shift": shift_name,
            # Attendance quality is separate from presence and roster access.
            # Do not turn a valid IN into absent just because its OUT is missing.
            "attendance_review_reason": attendance.get("review_reason") if attendance else None,
            "attendance_matching_status": attendance.get("matching_status") if attendance else None,
            "time_in": time_in,
            "status": status,  # "present" | "late" | "absent" | "on leave"
            "remarks": remarks,
        }

    if not groupings:
        return jsonify({
            "groups": [], "unassigned": [],
            "total_present": 0, "present_employees": [],
        })

    # NEW: roster rows with no line_name/shift are routed straight to
    # `unassigned` (mirrors groupings.py's fetch_current_state()) instead of
    # being grouped under a blank "||" key, which previously showed up as a
    # phantom line card with no name whenever an employee was added/edited
    # without a line assigned yet.
    seen_lines: dict[str, list] = {}
    assigned_ids: set[str]      = set()
    no_line_groupings: list     = []
    for g in groupings:
        line_name = (g["line_name"] or "").strip()
        shift     = (g["shift"] or "").strip()
        lookup_id = build_prefixed_id(g["emp_no"] or g["emp_id"], g["emp"]) or str(g["emp_id"]).strip().upper()
        assigned_ids.add(lookup_id)

        if not line_name or not shift:
            no_line_groupings.append(g)
            continue

        key = f"{line_name}||{shift}"
        seen_lines.setdefault(key, []).append(g)

    result_groups = []
    all_employees = []

    for key, line_groupings in seen_lines.items():
        line_name, shift = key.split("||", 1)
        members = []
        for g in line_groupings:
            lookup_id = build_prefixed_id(g["emp_no"] or str(g["emp_id"]).strip(), g["emp"]) \
                        or str(g["emp_id"]).strip().upper()
            if lookup_id in admin_ids:
                continue  # pulled out to the ADMIN card instead
            members.append(build_employee(g))

        group_obj = {
            "id":        key,
            "line_name": line_name,
            "shift":     shift,
            "count":     len(members),
            "employees": members,
        }

        # Level 1/2 (LINE/SECTION) users may not see this sheet at all —
        # check before doing any per-employee filtering.
        if not can_view_group(group_obj):
            continue

        # Within a visible sheet, still filter individual employees — a
        # SECTION-level sheet can mix employees from multiple sections.
        visible_members = [e for e in members if can_view_employee(e)]
        group_obj["employees"] = visible_members
        group_obj["count"] = len(visible_members)

        all_employees.extend(visible_members)
        result_groups.append(group_obj)

    admin_by_shift: dict[str, list] = {}
    for emp_id in admin_ids:
        att    = attendance_map[emp_id]
        master = master_map.get(emp_id) or {}
        shift  = att["shift_name"] or "Unassigned Shift"
        admin_remarks = str((master.get("remarks") if master else "") or "").strip()

        # CHANGED: was `"on leave" if admin_remarks else determine_roster_status(...)`.
        admin_fallback = determine_roster_status(shift, att["time_in"]).lower()
        admin_status = classify_remark_status(
            admin_remarks, admin_fallback, time_in=att["time_in"],
        )

        admin_by_shift.setdefault(shift, []).append({
            "id": emp_id,
            "name": master.get("name") or att["full_name"] or "Unknown",
            "agency": master.get("agency") or agency_code_from_emp_id(emp_id),
            "department": master.get("department", ""),
            "line_name": "",
            "section": "ADMIN",
            "shift": shift,
            "time_in": att["time_in"],
            "status": admin_status,
            "remarks": admin_remarks,
        })

    for shift, admin_members in admin_by_shift.items():
        admin_group_obj = {
            "id":        f"ADMIN||{shift}",
            "line_name": "ADMIN",
            "shift":     shift,
            "count":     len(admin_members),
            "employees": admin_members,
            "fixed":     True,
        }

        if not can_view_group(admin_group_obj):
            continue

        visible_admin = [e for e in admin_members if can_view_employee(e)]
        admin_group_obj["employees"] = visible_admin
        admin_group_obj["count"] = len(visible_admin)

        all_employees.extend(visible_admin)
        result_groups.append(admin_group_obj)

    # Unassigned: two sources feed this bucket —
    #   1) roster rows (frontend.employee_groupings) that have no
    #      line_name/shift assigned yet (e.g. a brand-new employee via
    #      Add Employee), and
    #   2) people who checked in today but aren't on any roster at all.
    # Both are filtered through admin routing and per-user visibility the
    # same way the line groups above are.
    unassigned = []

    for g in no_line_groupings:
        lookup_id = build_prefixed_id(g["emp_no"] or str(g["emp_id"]).strip(), g["emp"]) \
                    or str(g["emp_id"]).strip().upper()
        if lookup_id in admin_ids:
            continue  # still routed to the ADMIN card instead
        candidate = build_employee(g)
        if can_view_employee(candidate):
            unassigned.append(candidate)
            all_employees.append(candidate)

    for emp_id, att in attendance_map.items():
        if emp_id in assigned_ids or emp_id in admin_ids or att["time_in"] is None:
            continue
        if emp_id in inactive_ids:
            continue  # INACTIVE na empleyado -- hindi "unknown", huwag ilista sa Unassigned
        master = master_map.get(emp_id)
        candidate = {
            "id": emp_id,
            "name": (master["name"] if master else att["full_name"]) or "Unknown",
            "agency": (master["agency"] if master else None) or agency_code_from_emp_id(emp_id),
            "department": master["department"] if master else "",
            "line_name": "",
            "section": "Unassigned",
            "shift": att["shift_name"],
            "time_in": att["time_in"],
            "status": determine_roster_status(att["shift_name"], att["time_in"]).lower(),
        }
        if can_view_employee(candidate):
            unassigned.append(candidate)

    if auto_clear_leaves:
        _auto_clear_leave_remarks(auto_clear_leaves)

    present_or_late = [
        e for e in all_employees
        if e["status"] in ("present", "late")
    ]

    return jsonify({
        "groups": result_groups,
        "unassigned": unassigned,
        "total_present": len(present_or_late),
        "present_employees": present_or_late,
    })


@data_bp.route("/api/data/<int:batch_id>")
@login_required
def data_by_batch(batch_id: int):
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text("""
                SELECT s.emp_id, s.full_name, s.emp, s.process, s.line, s.shift,
                       g.emp_no AS emp_no, g.department AS department
                FROM frontend.employee_snapshot_records s
                LEFT JOIN frontend.employee_groupings g ON g.emp_id = s.emp_id
                WHERE s.batch_id = :batch_id
                ORDER BY s.line, s.shift, s.full_name
            """), {"batch_id": batch_id}).mappings().all()

        time_in_map = _fetch_time_in_map()

        groups: dict[str, dict] = {}
        for r in rows:
            line_name = (r["line"] or "").strip()
            shift     = (r["shift"] or "").strip()
            key       = f"{line_name}|{shift}"
            if key not in groups:
                groups[key] = {
                    "id": len(groups) + 1, "name": f"{line_name} ({shift})",
                    "line_name": line_name, "shift": shift,
                    "plant": "Plant 2" if shift.upper().startswith("NIGHT") else "Plant 1",
                    "employees": [], "count": 0,
                }
            lookup_id = build_prefixed_id(r["emp_no"] or str(r["emp_id"]).strip(), r["emp"]) \
                        or str(r["emp_id"]).strip().upper()
            groups[key]["employees"].append({
                "id": r["emp_id"], "name": r["full_name"],
                "agency": r["emp"], "department": r["department"] or "",
                "line_name": line_name, "section": r["process"], "status": "present",
                "time_in": time_in_map.get(lookup_id),
            })
            groups[key]["count"] += 1

        visible_groups = []
        for g in groups.values():
            if not can_view_group(g):
                continue
            g["employees"] = [e for e in g["employees"] if can_view_employee(e)]
            g["count"] = len(g["employees"])
            visible_groups.append(g)

        return jsonify({"groups": visible_groups, "unassigned": []})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


def _current_status_event_counts(conn, start=None, end=None):
    """
    Counts employees whose CURRENT status matches their most recent
    separated/rehired event, optionally restricted to events whose
    event_date falls in [start, end].

    This is deliberately NOT a raw COUNT(*) GROUP BY event_type over
    employee_status_events -- that counts every event ever logged,
    including ones later reversed. An employee separated and then
    rehired within the same window would otherwise inflate BOTH counts
    even though their net effect on headcount is zero. Keying off each
    emp_id's single latest event (DISTINCT ON) and cross-checking it
    against employee_groupings.employee_status collapses that down to
    "how many people are actually separated/rehired right now, and did
    that happen in this window."
    """
    match_clause = (
        "((le.event_type = 'Separated' AND g.employee_status = 'SEPARATED')"
        " OR (le.event_type = 'Rehired' AND g.employee_status = 'ACTIVE'))"
    )
    clauses = [match_clause]
    params = {}
    if start and end:
        clauses.append("le.event_date BETWEEN :start AND :end")
        params = {"start": start, "end": end}
    where = "WHERE " + " AND ".join(clauses)

    rows = conn.execute(sa_text(f"""
        WITH latest_events AS (
            SELECT DISTINCT ON (emp_id) emp_id, event_type, event_date
            FROM frontend.employee_status_events
            ORDER BY emp_id, event_date DESC, created_at DESC
        )
        SELECT le.event_type, COUNT(*)
        FROM latest_events le
        JOIN frontend.employee_groupings g ON g.emp_id = le.emp_id
        {where}
        GROUP BY le.event_type
    """), params).fetchall()

    counts = {"separated": 0, "rehired": 0}
    for event_type, count in rows:
        counts[(event_type or "").lower()] = count
    return counts


@data_bp.route("/api/dashboard-summary")
@login_required
def dashboard_summary():
    from datetime import datetime
    from routes.attendance import determine_status, is_valid_employee_record

    try:
        records = (get_json(attendance_window_url(ATTENDANCE_LOGS_URL), default={}) or {}).get("data", [])

        now, seen = datetime.now().time(), set()
        present = late = absent = pending = 0

        for record in records:
            if not is_valid_employee_record(record):
                continue

            emp_id = record_emp_key(record)
            att_date   = str(record.get("attendance_date", "")).strip()
            shift_name = record.get("shift_name", "")
            if not emp_id or emp_id in seen or not is_in_todays_window(att_date, shift_name, date.today(), now):
                continue
            seen.add(emp_id)

            status = determine_status(shift_name, record.get("time_in"), now)
            if status == "Present":  present += 1
            elif status == "Late":   late    += 1
            elif status == "Absent": absent  += 1
            else:                    pending += 1

        total    = present + late + absent + pending
        attended = present + late
        pct      = lambda val: round((val / total * 100), 2) if total > 0 else 0.0

        # Separated / rehired counts, month-to-date, net of any same-month
        # separate+rehire flip-flops (see _current_status_event_counts).
        # Wrapped separately so a problem here (e.g. table not yet
        # migrated) doesn't take down the rest of the dashboard summary.
        separated_count = rehired_count = 0
        try:
            month_start = date.today().replace(day=1)
            with db.engine.begin() as conn:
                counts = _current_status_event_counts(conn, month_start, date.today())
            separated_count, rehired_count = counts["separated"], counts["rehired"]
        except Exception as e:
            print("DASHBOARD STATUS EVENTS ERROR:", e)

        return jsonify({
            "present": attended, "late": late, "absent": absent, "pending": pending,
            "total": total, "attended": attended,
            "present_pct": pct(attended), "late_pct": pct(late),
            "absent_pct": pct(absent), "pending_pct": pct(pending),
            "attendance_rate": pct(attended),
            "separated_count": separated_count, "rehired_count": rehired_count,
            "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


@data_bp.route("/api/agency-stats")
@login_required
def agency_stats():
    try:
        attendance_data = get_json(ATTENDANCE_LOGS_URL, default=[]) or []
    except Exception:
        attendance_data = []

    today          = date.today()
    counts         = {"THN": 0, "CCI": 0, "NATCORP": 0, "EMIS": 0}
    seen: set[str] = set()

    for item in attendance_data:
        emp_id = str(item.get("emp_no", "")).strip()
        if not emp_id or emp_id in seen:
            continue
        if str(item.get("department", "")).strip().lower() not in ALLOWED_DEPARTMENTS:
            continue
        if parse_date(item.get("attendance_date", "")) != today:
            continue
        if not is_valid_checkin(item.get("check_in_time")):
            continue
        agency = agency_code_from_emp_id(emp_id)
        if agency in counts:
            counts[agency] += 1
            seen.add(emp_id)

    return jsonify([{"agency": k, "present": v} for k, v in counts.items()])


@data_bp.route("/api/attendance-analytics")
@login_required
def attendance_analytics():
    """Attendance rates grouped by an employee-master dimension.

    The employee roster supplies the denominator; attendance logs supply
    check-ins. This makes zero-attendance categories visible rather than
    omitting them from charts entirely.

    NOTE: this endpoint returns aggregate counts/rates only (no per-employee
    rows), so it is lower-severity than the list-returning endpoints above.
    It is not yet scoped per access_level — a LINE/SECTION-level user will
    currently see company-wide totals here, not just their own scope. Flag
    if you want that added; it requires re-deriving totals/roster per
    accessible scope rather than a simple row filter.
    """
    dimension = request.args.get("dimension", "agency").strip().lower()
    if dimension not in {"agency", "tenure", "department", "line"}:
        return jsonify({"success": False, "message": "Unsupported dimension."}), 400

    with db.engine.connect() as conn:
        roster_rows = conn.execute(sa_text("""
            SELECT emp_id, full_name, emp, department, line_name, line, tenure
            FROM frontend.employee_groupings
            WHERE COALESCE(employee_status, 'ACTIVE') <> 'INACTIVE'
        """)).mappings().all()
    roster_rows = dedupe_transferred_rows(roster_rows)  # para hindi madoble ang bilang sa totals

    roster = {row["emp_id"]: dict(row) for row in roster_rows if row["emp_id"]}
    totals: dict[str, int] = {}
    employee_categories: dict[str, str] = {}
    for emp_id, employee in roster.items():
        category = _analytics_dimension_value(employee, dimension)
        employee_categories[emp_id] = category
        totals[category] = totals.get(category, 0) + 1

    try:
        month_index = date.today().year * 12 + date.today().month - 1 - 5
        chart_start = date(month_index // 12, month_index % 12 + 1, 1)
        payload = get_json(attendance_window_url(ATTENDANCE_LOGS_URL, chart_start), ttl=30, default={}) or {}
        attendance_rows = payload.get("data", payload if isinstance(payload, list) else [])
    except Exception:
        attendance_rows = []

    present_by_date: dict[date, dict[str, set[str]]] = {}
    observed_dates: set[date] = set()
    for row in attendance_rows:
        if not is_valid_employee_record(row):
            continue
        attendance_date = parse_date(row.get("attendance_date", ""))
        emp_id = str(row.get("emp_id") or "").strip().upper()
        if not emp_id:
            emp_id = build_prefixed_id(row.get("emp_no", ""), row.get("emp"))
        category = employee_categories.get(emp_id)
        if not attendance_date or not category:
            continue
        observed_dates.add(attendance_date)
        if is_valid_checkin(row.get("time_in")):
            present_by_date.setdefault(attendance_date, {}).setdefault(category, set()).add(emp_id)

    today = date.today()
    week_dates = [today - timedelta(days=offset) for offset in range(6, -1, -1)]
    month_keys = []
    year, month = today.year, today.month
    for _ in range(6):
        month_keys.append((year, month))
        month = 12 if month == 1 else month - 1
        year = year - 1 if month == 12 else year
    month_keys.reverse()

    # Keep dashboard charts readable while still including all agency groups.
    categories = sorted(totals, key=lambda key: (-totals[key], key))[:12]

    def rate_for(day_value: date, category: str):
        if day_value not in observed_dates:
            return None
        total = totals[category]
        return round(len(present_by_date.get(day_value, {}).get(category, set())) / total * 100, 1) if total else 0

    weekly = {
        "labels": [day_value.strftime("%b %d") for day_value in week_dates],
        "datasets": [{"label": category, "data": [rate_for(day_value, category) for day_value in week_dates]}
                     for category in categories],
    }

    monthly_datasets = []
    for category in categories:
        data = []
        for year, month in month_keys:
            rates = [rate_for(day_value, category) for day_value in observed_dates
                     if day_value.year == year and day_value.month == month]
            rates = [rate for rate in rates if rate is not None]
            data.append(round(sum(rates) / len(rates), 1) if rates else None)
        monthly_datasets.append({"label": category, "data": data})

    today_present = present_by_date.get(today, {})
    return jsonify({
        "success": True,
        "dimension": dimension,
        "categories": [{
            "label": category,
            "total": totals[category],
            "present": len(today_present.get(category, set())),
            "attendance_rate": rate_for(today, category),
        } for category in categories],
        "weekly": weekly,
        "monthly": {
            "labels": [f"{year}-{month:02d}" for year, month in month_keys],
            "datasets": monthly_datasets,
        },
    })


@data_bp.route("/api/time")
def server_time():
    from datetime import datetime
    now = datetime.now()
    return jsonify({"time": now.strftime("%I:%M:%S %p"), "date": now.strftime("%Y-%m-%d")})


@data_bp.route("/api/attendance-dashboard")
@login_required
def attendance_dashboard():
    from routes.attendance import is_valid_employee_record, determine_roster_status, EXPECTED_BENCHMARK

    requested_shift = request.args.get("shift", "Day Shift").strip()

    try:
        master_employees = get_json(EMPLOYEES_URL, ttl=30, default=[]) or []
    except Exception as e:
        print("EMPLOYEE API ERROR:", e)
        master_employees = []

    master_map: dict[str, dict] = {}
    for emp in master_employees:
        emp_id = build_prefixed_id(emp.get("emp_no", ""), emp.get("emp"))
        if not emp_id:
            continue
        full_name = emp.get("full_name") or " ".join(filter(None, [
            emp.get("first_name", ""), emp.get("last_name", "")
        ]))
        master_map[emp_id] = {
            "name": full_name,
            "position": emp.get("position") or "",
            # Needed by can_view_employee — without these, every row here
            # is treated as department="" and denied for non-GLOBAL users.
            "department": emp.get("department") or "",
            "line_name": emp.get("line_name") or "",
        }

    # DB roster is the authoritative source for department/line_name (same
    # source attendance.py trusts); use it to backfill/override the
    # external feed's copy where available.
    with db.engine.connect() as conn:
        roster_rows = conn.execute(sa_text("""
            SELECT emp_id, emp_no, emp, department, line_name
            FROM frontend.employee_groupings
        """)).mappings().all()

    for r in roster_rows:
        lookup_id = build_prefixed_id(r["emp_no"] or str(r["emp_id"]).strip(), r["emp"]) \
                    or str(r["emp_id"]).strip().upper()
        entry = master_map.setdefault(lookup_id, {"name": "", "position": "", "department": "", "line_name": ""})
        entry["department"] = r["department"] or entry["department"]
        entry["line_name"] = r["line_name"] or entry["line_name"]

    try:
        log_records = (get_json(attendance_window_url(ATTENDANCE_LOGS_URL), default={}) or {}).get("data", [])
    except Exception as e:
        print("ATTENDANCE LOGS ERROR:", e)
        return jsonify({"success": False, "message": f"Failed to fetch logs: {str(e)}"}), 500

    today, now = date.today(), datetime.now().time()
    seen: set[str] = set()
    employees = []

    for record in log_records:
        if not is_valid_employee_record(record):
            continue

        emp_id = record_emp_key(record)
        if not emp_id or emp_id in seen:
            continue

        # THN only — exclude NATCORP, CCI, EMIS by agency prefix.
        if agency_code_from_emp_id(emp_id) != "THN":
            continue

        shift_name = record.get("shift_name") or ""
        if requested_shift and shift_name.strip().lower() != requested_shift.lower():
            continue

        att_date = str(record.get("attendance_date", "")).strip()
        if not is_in_todays_window(att_date, shift_name, today, now):
            continue

        seen.add(emp_id)

        time_in  = record.get("time_in")
        time_out = record.get("time_out")
        time_in  = time_in if is_valid_checkin(time_in) else None

        status = determine_roster_status(shift_name, time_in).lower()

        master = master_map.get(emp_id, {})

        employees.append({
            "emp_id": emp_id,
            "full_name": master.get("name") or str(record.get("full_name", "")).strip() or "Unknown",
            "position": master.get("position", ""),
            "department": master.get("department", ""),
            "line_name": master.get("line_name", ""),
            "shift_name": shift_name,
            "time_in": time_in,
            "time_out": time_out,
            "status": status,
            "attendance_date": att_date,
        })

    # Apply the 4-tier visibility filter before computing any metrics —
    # counts/percentages must reflect only what this user can see.
    employees = [e for e in employees if can_view_employee({
        "department": e.get("department", ""),
        "line_name":  e.get("line_name", ""),
        "shift":      e.get("shift_name", ""),
    })]

    counts = {"present": 0, "late": 0, "absent": 0, "pending": 0}
    for e in employees:
        counts[e["status"]] = counts.get(e["status"], 0) + 1

    total = len(employees)
    pct = lambda c: round((c / total * 100), 1) if total else 0.0

    metrics = {
        "total_employees": total,
        "present_count": counts["present"], "present_percentage": pct(counts["present"]),
        "late_count": counts["late"],       "late_percentage": pct(counts["late"]),
        "absent_count": counts["absent"],   "absent_percentage": pct(counts["absent"]),
        "pending_count": counts["pending"], "pending_percentage": pct(counts["pending"]),
    }

    validation = None
    if requested_shift.lower() == "day shift":
        actual = counts["present"] + counts["late"] + counts["absent"]
        validation = {
            "expected_benchmark": EXPECTED_BENCHMARK,
            "actual_thn_day_count": actual,
            "passed": actual == EXPECTED_BENCHMARK,
        }

    return jsonify({
        "success": True,
        "employees": employees,
        "metrics": metrics,
        "validation": validation,
    })


@data_bp.route("/api/employees")
@login_required
def get_employees():
    try:
        employees = get_json(EMPLOYEES_URL, ttl=30, default=None)
        if employees is None:
            raise RuntimeError("Employee service is unavailable.")
        visible = [e for e in employees if can_view_employee(e)]
        return jsonify(visible)
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@data_bp.route("/api/employees/bulk-leave", methods=["PUT"])
@level_2_to_4_required
def bulk_leave():
    payload = request.get_json(silent=True) or {}
    employee_ids = payload.get("employee_ids", [])
    reason = (payload.get("reason") or "").strip()
    leave_until = (payload.get("leave_until") or "").strip()  # "YYYY-MM-DD" or ""

    if not employee_ids or not isinstance(employee_ids, list):
        return jsonify({"success": False, "message": "employee_ids must be a non-empty list"}), 400
    if not reason:
        return jsonify({"success": False, "message": "A leave reason is required"}), 400

    remarks_text = f"ON LEAVE | Reason: {reason}"
    if leave_until:
        remarks_text += f" | Until: {leave_until}"

    updated = 0
    failures = []

    with db.engine.begin() as conn:
        for emp_id in employee_ids:
            try:
                result = conn.execute(sa_text("""
                    UPDATE frontend.employee_groupings
                    SET remarks = :remarks, updated_at = NOW()
                    WHERE emp_id = :emp_id
                """), {"remarks": remarks_text, "emp_id": str(emp_id).strip().upper()})
                if result.rowcount > 0:
                    updated += 1
                else:
                    failures.append({"emp_id": emp_id, "reason": "not found"})
            except Exception as e:
                print("BULK LEAVE ROW ERROR:", e)
                failures.append({"emp_id": emp_id, "reason": str(e)})

    return jsonify({"success": True, "updated": updated, "failures": failures})


@data_bp.route("/api/employees/bulk-return", methods=["PUT"])
@level_2_to_4_required
def bulk_return():
    """Clears leave status — employee is back to work."""
    payload = request.get_json(silent=True) or {}
    employee_ids = payload.get("employee_ids", [])

    if not employee_ids or not isinstance(employee_ids, list):
        return jsonify({"success": False, "message": "employee_ids must be a non-empty list"}), 400

    updated = 0
    failures = []

    with db.engine.begin() as conn:
        for emp_id in employee_ids:
            try:
                result = conn.execute(sa_text("""
                    UPDATE frontend.employee_groupings
                    SET remarks = NULL
                    WHERE emp_id = :emp_id
                """), {"emp_id": str(emp_id).strip().upper()})
                if result.rowcount > 0:
                    updated += 1
                else:
                    failures.append({"emp_id": emp_id, "reason": "not found"})
            except Exception as e:
                print("BULK RETURN ROW ERROR:", e)
                failures.append({"emp_id": emp_id, "reason": str(e)})

    return jsonify({"success": True, "updated": updated, "failures": failures})
@data_bp.route("/api/employees/bulk-separate", methods=["POST"])
@level_2_to_4_required
def bulk_separate():
    """
    Logs a 'separated' event per employee in employee_status_events and
    flips employee_groupings.employee_status to SEPARATED. Employees stay
    visible in Employee Management (not filtered like INACTIVE) so they
    can later be selected again for Mark Rehired.

    Guard: an employee who is already SEPARATED cannot be separated again
    -- that would log a duplicate 'separated' event with no rehire in
    between. They must go through Mark Rehired first (which flips them
    back to ACTIVE) before they're eligible to be separated again.
    """
    payload = request.get_json(silent=True) or {}
    employee_ids = payload.get("employee_ids", [])
    reason = (payload.get("reason") or "").strip()
    event_date = (payload.get("event_date") or "").strip() or date.today().isoformat()
    created_by = current_username()

    if not employee_ids or not isinstance(employee_ids, list):
        return jsonify({"success": False, "message": "employee_ids must be a non-empty list"}), 400
    if not reason:
        return jsonify({"success": False, "message": "A separation reason is required"}), 400

    updated = 0
    failures = []

    with db.engine.begin() as conn:
        for emp_id in employee_ids:
            emp_id_norm = str(emp_id).strip().upper()
            try:
                status_row = conn.execute(sa_text("""
                    SELECT employee_status, full_name FROM frontend.employee_groupings
                    WHERE emp_id = :emp_id
                """), {"emp_id": emp_id_norm}).fetchone()

                if status_row is None:
                    failures.append({"emp_id": emp_id, "reason": "not found"})
                    continue

                current_status, full_name = status_row[0], status_row[1]
                if (current_status or "").strip().upper() == "SEPARATED":
                    failures.append({
                        "emp_id": emp_id,
                        "reason": "employee is already separated; mark rehired before separating again",
                    })
                    continue

                result = conn.execute(sa_text("""
                    UPDATE frontend.employee_groupings
                    SET employee_status = 'SEPARATED', updated_at = NOW()
                    WHERE emp_id = :emp_id
                """), {"emp_id": emp_id_norm})
                if result.rowcount == 0:
                    failures.append({"emp_id": emp_id, "reason": "not found"})
                    continue

                conn.execute(sa_text("""
                    INSERT INTO frontend.employee_status_events
                        (emp_id, full_name, event_type, event_date, reason, created_by)
                    VALUES (:emp_id, :full_name, 'Separated', :event_date, :reason, :created_by)
                """), {"emp_id": emp_id_norm, "full_name": full_name, "event_date": event_date,
                       "reason": reason, "created_by": created_by})
                updated += 1
            except Exception as e:
                print("BULK SEPARATE ROW ERROR:", e)
                failures.append({"emp_id": emp_id, "reason": str(e)})

    return jsonify({"success": True, "updated": updated, "failures": failures})


@data_bp.route("/api/employees/bulk-rehire", methods=["POST"])
@level_2_to_4_required
def bulk_rehire():
    """
    Logs a 'rehired' event per employee and flips employee_status back to
    ACTIVE. Only HR/Administration accounts can call this
    (hr_approval_required -- Admin role or ADMINISTRATION department; see
    routes/auth.py). Two guards are enforced per employee before anything
    is written:

      1. The employee must currently be SEPARATED. You can't "rehire"
         someone who's already active.
      2. If they already have a 'rehired' event within the last
         REHIRE_COOLDOWN_DAYS days, the request is rejected as a likely
         duplicate (e.g. a double-click or double-submit).

    `bypass_cooldown: true` in the payload skips guard #2. This is a
    testing/QA safety net so cooldown behavior can be verified immediately
    without waiting out the real window -- it does NOT skip the HR role
    check or the "must be separated" check. Treat this flag as
    testing-only; consider removing or further restricting it before
    relying on this endpoint in production.
    """
    payload = request.get_json(silent=True) or {}
    employee_ids = payload.get("employee_ids", [])
    reason = (payload.get("reason") or "").strip()
    event_date = (payload.get("event_date") or "").strip() or date.today().isoformat()
    created_by = current_username()
    bypass_cooldown = bool(payload.get("bypass_cooldown", False))

    if not employee_ids or not isinstance(employee_ids, list):
        return jsonify({"success": False, "message": "employee_ids must be a non-empty list"}), 400

    if bypass_cooldown:
        print(f"BULK REHIRE: cooldown bypass requested by '{created_by}' for {employee_ids}")

    try:
        event_date_obj = datetime.strptime(event_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"success": False, "message": "event_date must be YYYY-MM-DD"}), 400

    updated = 0
    failures = []

    with db.engine.begin() as conn:
        for emp_id in employee_ids:
            emp_id_norm = str(emp_id).strip().upper()
            try:
                status_row = conn.execute(sa_text("""
                    SELECT employee_status, full_name FROM frontend.employee_groupings
                    WHERE emp_id = :emp_id
                """), {"emp_id": emp_id_norm}).fetchone()

                if status_row is None:
                    failures.append({"emp_id": emp_id, "reason": "not found"})
                    continue

                current_status, full_name = status_row[0], status_row[1]
                if (current_status or "").strip().upper() != "SEPARATED":
                    failures.append({
                        "emp_id": emp_id,
                        "reason": f"employee is not separated (current status: {current_status or 'UNKNOWN'})",
                    })
                    continue

                if not bypass_cooldown:
                    last_rehire = conn.execute(sa_text("""
                        SELECT event_date FROM frontend.employee_status_events
                        WHERE emp_id = :emp_id AND event_type = 'Rehired'
                        ORDER BY event_date DESC, created_at DESC
                        LIMIT 1
                    """), {"emp_id": emp_id_norm}).fetchone()

                    if last_rehire and last_rehire[0]:
                        days_since = (event_date_obj - last_rehire[0]).days
                        if days_since < REHIRE_COOLDOWN_DAYS:
                            failures.append({
                                "emp_id": emp_id,
                                "reason": (f"duplicate rehire blocked: last rehired {days_since} day(s) ago, "
                                           f"must wait {REHIRE_COOLDOWN_DAYS} days or 3 months before rehiring again"),
                            })
                            continue

                result = conn.execute(sa_text("""
                    UPDATE frontend.employee_groupings
                    SET employee_status = 'ACTIVE', updated_at = NOW()
                    WHERE emp_id = :emp_id
                """), {"emp_id": emp_id_norm})
                if result.rowcount == 0:
                    failures.append({"emp_id": emp_id, "reason": "not found"})
                    continue

                conn.execute(sa_text("""
                    INSERT INTO frontend.employee_status_events
                        (emp_id, full_name, event_type, event_date, reason, created_by)
                    VALUES (:emp_id, :full_name, 'Rehired', :event_date, :reason, :created_by)
                """), {"emp_id": emp_id_norm, "full_name": full_name, "event_date": event_date,
                       "reason": reason, "created_by": created_by})
                updated += 1
            except Exception as e:
                print("BULK REHIRE ROW ERROR:", e)
                failures.append({"emp_id": emp_id, "reason": str(e)})

    return jsonify({"success": True, "updated": updated, "failures": failures})


@data_bp.route("/api/status-events", methods=["GET"])
@login_required
def list_status_events():
    """
    ?type=separated|rehired (optional) and/or ?start=YYYY-MM-DD&end=YYYY-MM-DD
    (optional). No filters returns full history, most recent first.

    ?current_only=true restricts to each emp_id's single latest event,
    and only where it still matches their current employee_status --
    i.e. the same "net" logic as /api/status-events/summary, so a
    drill-down from that count doesn't show events that were later
    reversed. Without this flag, the full raw history is returned
    (useful for an audit trail, just not for matching the summary count).
    """
    event_type = (request.args.get("type") or "").strip().lower()
    start = request.args.get("start")
    end = request.args.get("end")
    current_only = (request.args.get("current_only") or "").strip().lower() == "true"

    clauses, params = [], {}
    if event_type in ("separated", "rehired"):
        clauses.append("e.event_type = :event_type")
        params["event_type"] = event_type.capitalize()  # DB stores 'Separated'/'Rehired'
    if start and end:
        clauses.append("e.event_date BETWEEN :start AND :end")
        params["start"], params["end"] = start, end
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    if current_only:
        clauses.append(
            "((e.event_type = 'Separated' AND g.employee_status = 'SEPARATED')"
            " OR (e.event_type = 'Rehired' AND g.employee_status = 'ACTIVE'))"
        )
        where = f"WHERE {' AND '.join(clauses)}"
        query = f"""
            WITH latest_events AS (
                SELECT DISTINCT ON (emp_id) *
                FROM frontend.employee_status_events e
                ORDER BY emp_id, event_date DESC, created_at DESC
            )
            SELECT e.id, e.emp_id, e.full_name, e.event_type, e.event_date,
                   e.reason, e.created_by, e.created_at, g.full_name AS current_full_name
            FROM latest_events e
            LEFT JOIN frontend.employee_groupings g ON g.emp_id = e.emp_id
            {where}
            ORDER BY e.event_date DESC, e.created_at DESC
        """
    else:
        query = f"""
            SELECT e.id, e.emp_id, e.full_name, e.event_type, e.event_date,
                   e.reason, e.created_by, e.created_at, g.full_name AS current_full_name
            FROM frontend.employee_status_events e
            LEFT JOIN frontend.employee_groupings g ON g.emp_id = e.emp_id
            {where}
            ORDER BY e.event_date DESC, e.created_at DESC
        """

    with db.engine.begin() as conn:
        rows = conn.execute(sa_text(query), params).fetchall()

    return jsonify([
        {
            "id": r[0], "emp_id": r[1],
            "full_name": r[2] or r[8],  # backfill from current roster if the event predates the full_name column
            "event_type": r[3],
            "event_date": str(r[4]) if r[4] else None,
            "reason": r[5], "created_by": r[6],
            "created_at": str(r[7]) if r[7] else None,
        }
        for r in rows
    ])


@data_bp.route("/api/status-events/summary", methods=["GET"])
@login_required
def status_events_summary():
    """
    ?start=YYYY-MM-DD&end=YYYY-MM-DD (optional; no range = all-time).
    See _current_status_event_counts for why this isn't a raw event tally.
    """
    start = request.args.get("start")
    end = request.args.get("end")

    with db.engine.begin() as conn:
        counts = _current_status_event_counts(conn, start, end)

    return jsonify({
        "success": True,
        "separated_count": counts["separated"],
        "rehired_count": counts["rehired"],
    })


@data_bp.route("/api/employees/<emp_id>/remark", methods=["PUT"])
@line_leader_required
def update_employee_remark(emp_id: str):
    """
    Sets a single employee's remark to a raw value — either a leave code
    (VL/SL/ML/SS/PL) picked from the combobox preset, or free-text typed by the
    user. Classification into on_leave vs. absent happens on read, in
    classify_remark_status() above — this endpoint just persists the string.
    """
    payload = request.get_json(silent=True) or {}
    remark = (payload.get("remark") or "").strip()

    normalized_id = str(emp_id).strip().upper()

    with db.engine.begin() as conn:
        target = conn.execute(sa_text("""
            SELECT department, line_name, shift
            FROM frontend.employee_groupings WHERE emp_id = :emp_id
        """), {"emp_id": normalized_id}).mappings().first()
        if not target:
            return jsonify({"success": False, "message": "Employee not found."}), 404
        if not can_view_employee(dict(target)):
            return jsonify({"success": False, "message": "Employee is outside your assigned line."}), 403
        result = conn.execute(sa_text("""
            UPDATE frontend.employee_groupings
            SET remarks = :remarks, updated_at = NOW()
            WHERE emp_id = :emp_id
        """), {"remarks": remark or None, "emp_id": normalized_id})

    if result.rowcount == 0:
        return jsonify({"success": False, "message": "Employee not found."}), 404

    return jsonify({"success": True, "emp_id": normalized_id, "remark": remark})


# ============================================================
# AVAILABLE LINES (for the Create Account "Line" dropdown)
# ============================================================
@data_bp.route("/api/available-lines")
def available_lines():
    """Returns the distinct line_name values currently in the roster for a
    given department, so the Create Account form's "Line" field can be a
    dropdown instead of free text -- this is what stops someone from
    typing "Line 4 2nd" (which _extract_line_key would silently collapse
    to the same key as plain "Line 4") instead of the correct "L4 2ND".

    Deliberately NOT behind @login_required: the Create Account form on
    the public login page (index.html) calls this before any session
    exists, exactly like /register itself has no login_required. This
    means an unauthenticated visitor can see the list of line names for
    a department (not employee data, not attendance data -- just the
    line labels themselves). If Create Account is later moved behind an
    admin-only screen, this should get @login_required to match.

    ?department=PRODUCTION|QUALITY -- the only two LINE_LEVEL_DEPARTMENTS
    (see auth.py). Any other value returns an empty list rather than an
    error, since the frontend only calls this when access_level is LINE,
    which itself is only offered for these two departments.
    """
    department = (request.args.get("department") or "").strip().upper()
    if department not in LINE_LEVEL_DEPARTMENTS:
        return jsonify({"success": True, "lines": []})

    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT DISTINCT line_name, department
            FROM frontend.employee_groupings
            WHERE line_name IS NOT NULL
              AND TRIM(line_name) <> ''
              AND COALESCE(employee_status, 'ACTIVE') <> 'INACTIVE'
        """)).mappings().all()

    lines = set()
    for row in rows:
        emp_dept, _section = parse_employee_department(row["department"])
        if emp_dept == department:
            name = (row["line_name"] or "").strip()
            if name:
                lines.add(name)

    return jsonify({"success": True, "lines": sorted(lines)})


# ============================================================
# LINE FLOOR PLAN LAYOUT (per-line, editable by Line Leaders)
# ============================================================
# ============================================================
# SHIFT-ONLY LINE TRANSITIONS
# ============================================================
# Transition records are a durable audit log.  The active dashboard state is
# always filtered to the current SHIFT date: the calendar date for day shift,
# and the date the shift started for night shift (7 PM -> 4 AM, OT until 7 AM).
# Once the shift is over the assignments disappear and everyone is back on
# their original process, without touching the roster.

@data_bp.route("/api/line-transitions", methods=["GET"])
@login_required
def get_line_transitions():
    raw_line = request.args.get("line") or ""
    line = _line_transition_access(raw_line)
    if not line:
        return jsonify({"success": False, "message": "forbidden"}), 403

    include_history = (request.args.get("history") or "").lower() == "true"
    # Optional: the viewer's shift. When given, only that shift's transitions
    # are returned so a day leader never sees night coverage and vice versa.
    shift_arg = (request.args.get("shift") or "").strip()
    shift_filter = _normalize_shift_type(shift_arg) if shift_arg else ""
    day_date = _shift_business_date("day")
    night_date = _shift_business_date("night")
    source_line_by_employee = {}
    with db.engine.begin() as conn:
        _ensure_line_transition_table(conn)
        if include_history:
            rows = conn.execute(sa_text("""
                SELECT * FROM (
                    SELECT id::TEXT AS id, transition_date, target_line, target_process,
                           original_employee_id, original_employee_name,
                           replacement_employee_id, replacement_employee_name,
                           replacement_line, replacement_process, transition_type,
                           status, is_active, created_by, created_at
                    FROM frontend.line_transition_history
                    WHERE (target_line = :line OR replacement_line = :line)
                      AND status <> 'cancelled'
                    UNION ALL
                    SELECT ('status-' || employee_id)::TEXT AS id, status_date AS transition_date,
                           target_line, target_process, employee_id AS original_employee_id,
                           employee_name AS original_employee_name, NULL AS replacement_employee_id,
                           NULL AS replacement_employee_name, NULL AS replacement_line,
                           NULL AS replacement_process, 'attendance' AS transition_type,
                           status, TRUE AS is_active, NULL AS created_by, recorded_at AS created_at
                    FROM frontend.line_process_status_history
                    WHERE target_line = :line
                ) history
                ORDER BY created_at DESC
                LIMIT 500
            """), {"line": line}).mappings().all()
        else:
            rows = conn.execute(sa_text("""
                SELECT id, transition_date, target_line, target_process,
                       original_employee_id, original_employee_name,
                       replacement_employee_id, replacement_employee_name,
                       replacement_line, replacement_process, transition_type,
                       status, is_active, created_by, created_at
                FROM frontend.line_transition_history
                WHERE COALESCE(shift_date, transition_date) =
                          CASE WHEN COALESCE(shift_type, 'day') = 'night'
                               THEN CAST(:night_date AS DATE)
                               ELSE CAST(:day_date AS DATE) END
                  AND is_active = TRUE
                  AND (CAST(:shift AS TEXT) = '' OR COALESCE(shift_type, 'day') = CAST(:shift AS TEXT))
                ORDER BY created_at ASC
            """), {"line": line, "night_date": night_date, "day_date": day_date,
                   "shift": shift_filter}).mappings().all()
            # Old transition rows may contain a display-form source line
            # (for example "L3 DS") while a Line Leader logs in under its
            # canonical form ("LINE 3"). Resolve the donor from the roster
            # too, so those rows still hide the employee on their home line.
            for replacement_id in {str(r["replacement_employee_id"] or "").strip() for r in rows}:
                if not replacement_id:
                    continue
                roster_row = conn.execute(sa_text("""
                    SELECT line_name FROM frontend.employee_groupings
                    WHERE emp_id = :emp_id
                    LIMIT 1
                """), {"emp_id": replacement_id}).mappings().first()
                if roster_row:
                    source_line_by_employee[replacement_id] = roster_row["line_name"] or ""
    transitions = []
    for row in rows:
        item = dict(row)
        is_target_line = item.get("target_line") == line
        replacement_line = _extract_line_key(str(item.get("replacement_line") or "").upper())
        roster_source_line = _extract_line_key(str(source_line_by_employee.get(str(item.get("replacement_employee_id") or ""), "")).upper())
        if not include_history and not is_target_line and replacement_line != line and roster_source_line != line:
            continue
        item["is_target_line"] = is_target_line
        transitions.append(item)
    return jsonify({"success": True, "transitions": transitions})


@data_bp.route("/api/line-process-history/snapshot", methods=["POST"])
@line_leader_required
def snapshot_line_process_history():
    payload = request.get_json(silent=True) or {}
    line = _line_transition_access(payload.get("target_line") or "")
    entries = payload.get("entries")
    snapshot_date = _shift_business_date(payload.get("shift_type"))
    if not line:
        return jsonify({"success": False, "message": "forbidden"}), 403
    if not isinstance(entries, list) or len(entries) > 1000:
        return jsonify({"success": False, "message": "entries must be a list of at most 1000 employees."}), 400

    clean = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        employee_id = str(entry.get("employee_id") or "").strip()
        employee_name = str(entry.get("employee_name") or "").strip()
        process = str(entry.get("process") or "").strip()
        status = str(entry.get("status") or "").strip().lower()
        if employee_id and employee_name and process and status in {"present", "absent", "late", "on leave"}:
            clean.append({"employee_id": employee_id, "employee_name": employee_name, "process": process, "status": status})
    with db.engine.begin() as conn:
        _ensure_line_transition_table(conn)
        for entry in clean:
            conn.execute(sa_text("""
                INSERT INTO frontend.line_process_status_history
                  (status_date, target_line, target_process, employee_id, employee_name, status)
                VALUES (:status_date, :line, :process, :employee_id, :employee_name, :status)
                ON CONFLICT (status_date, target_line, target_process, employee_id)
                DO UPDATE SET employee_name = EXCLUDED.employee_name,
                              status = EXCLUDED.status, recorded_at = NOW()
            """), {"line": line, "status_date": snapshot_date, **entry})
    return jsonify({"success": True, "recorded": len(clean)})


@data_bp.route("/api/line-transitions", methods=["POST"])
@line_leader_required
def save_line_transition():
    payload = request.get_json(silent=True) or {}
    line = _line_transition_access(payload.get("target_line") or "")
    if not line:
        return jsonify({"success": False, "message": "You can only cover a process on your assigned line."}), 403

    required = ("target_process", "replacement_employee_id", "replacement_employee_name")
    if any(not str(payload.get(key) or "").strip() for key in required):
        return jsonify({"success": False, "message": "Missing transition details."}), 400
    transition_type = (payload.get("transition_type") or "").strip().lower()
    if transition_type not in {"intra-line", "cross-line"}:
        return jsonify({"success": False, "message": "Invalid transition type."}), 400

    shift_type = _normalize_shift_type(payload.get("shift_type"))
    values = {
        "line": line,
        "shift_type": shift_type,
        "shift_date": _shift_business_date(shift_type),
        "target_process": str(payload["target_process"]).strip(),
        "original_id": str(payload.get("original_employee_id") or "").strip(),
        "original_name": str(payload.get("original_employee_name") or "").strip(),
        "replacement_id": str(payload["replacement_employee_id"]).strip(),
        "replacement_name": str(payload["replacement_employee_name"]).strip(),
        "replacement_line": _extract_line_key(str(payload.get("replacement_line") or "").strip().upper()),
        "replacement_process": str(payload.get("replacement_process") or "").strip(),
        "transition_type": transition_type,
        "created_by": current_username(),
    }
    with db.engine.begin() as conn:
        _ensure_line_transition_table(conn)
        # Replacing the same absent slot supersedes the previous one.
        if values["original_id"]:
            conn.execute(sa_text("""
                UPDATE frontend.line_transition_history
                SET is_active = FALSE, status = 'superseded'
                WHERE COALESCE(shift_date, transition_date) = :shift_date
                  AND COALESCE(shift_type, 'day') = :shift_type
                  AND target_line = :line
                  AND target_process = :target_process
                  AND original_employee_id = :original_id
                  AND is_active = TRUE
            """), values)
        # A person can only be in one temporary spot per day.
        conn.execute(sa_text("""
            UPDATE frontend.line_transition_history
            SET is_active = FALSE, status = 'superseded'
            WHERE COALESCE(shift_date, transition_date) = :shift_date
              AND COALESCE(shift_type, 'day') = :shift_type
              AND target_line = :line
              AND replacement_employee_id = :replacement_id
              AND is_active = TRUE
        """), values)
        row = conn.execute(sa_text("""
            INSERT INTO frontend.line_transition_history
              (transition_date, shift_date, shift_type,
               target_line, target_process, original_employee_id, original_employee_name,
               replacement_employee_id, replacement_employee_name, replacement_line,
               replacement_process, transition_type, created_by)
            VALUES
              (:shift_date, :shift_date, :shift_type,
               :line, :target_process, NULLIF(CAST(:original_id AS TEXT), ''), NULLIF(CAST(:original_name AS TEXT), ''),
               :replacement_id, :replacement_name, :replacement_line,
               :replacement_process, :transition_type, :created_by)
            RETURNING id, transition_date, created_at
        """), values).mappings().one()
    return jsonify({"success": True, "transition": dict(row)})


@data_bp.route("/api/line-transitions", methods=["DELETE"])
@line_leader_required
def undo_line_transition():
    payload = request.get_json(silent=True) or {}
    line = _line_transition_access(payload.get("target_line") or "")
    if not line:
        return jsonify({"success": False, "message": "You can only undo transitions on your assigned line."}), 403

    original_id = str(payload.get("original_employee_id") or "").strip()
    replacement_id = str(payload.get("replacement_employee_id") or "").strip()
    target_process = str(payload.get("target_process") or "").strip()
    shift_type = _normalize_shift_type(payload.get("shift_type"))
    shift_date = _shift_business_date(shift_type)
    if not replacement_id:
        return jsonify({"success": False, "message": "Missing transition details."}), 400

    with db.engine.begin() as conn:
        _ensure_line_transition_table(conn)
        result = conn.execute(sa_text("""
            UPDATE frontend.line_transition_history
            SET is_active = FALSE, status = 'cancelled'
            WHERE COALESCE(shift_date, transition_date) = :shift_date
              AND COALESCE(shift_type, 'day') = :shift_type
              AND target_line = :line
              AND replacement_employee_id = :replacement_id
              AND COALESCE(original_employee_id, '') = :original_id
              AND (:target_process = '' OR target_process = :target_process)
              AND is_active = TRUE
        """), {"line": line, "original_id": original_id,
               "replacement_id": replacement_id, "target_process": target_process,
               "shift_type": shift_type, "shift_date": shift_date})

    if result.rowcount == 0:
        return jsonify({"success": False, "message": "Transition not found or already undone."}), 404
    return jsonify({"success": True})

# ===== LINE TRANSITION: department-scoped lists =====
ASSEMBLY_DEPT = "PRODUCTION-ASSEMBLY"
ASSEMBLY_POSITIONS = ["SR.LEADER", "LINELEADER", "ASST.LEADER", "OPERATOR"]
# Lines that must never appear as a source for temporary assignments
EXCLUDED_TRANSITION_LINES = ["ADMIN DS", "ADMIN NS"]


def _transition_scope(conn, target_line):
    """
    Returns (department, allowed_positions) based on the leader's own line.
      - PRODUCTION-ASSEMBLY leader -> assembly lines; leaders + operators
      - any other department (e.g. PRODUCTION-CC) -> same department only;
        all positions (positions = None)
    """
    row = conn.execute(sa_text("""
        SELECT UPPER(REPLACE(TRIM(COALESCE(department, '')), ' ', '')) AS dept,
               COUNT(*) AS n
        FROM frontend.employee_groupings
        WHERE UPPER(TRIM(line_name)) = UPPER(TRIM(:line))
          AND COALESCE(employee_status, 'ACTIVE') <> 'INACTIVE'
          AND TRIM(COALESCE(department, '')) <> ''
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 1
    """), {"line": target_line}).first()

    dept = row[0] if row else ASSEMBLY_DEPT
    # None = no position restriction (all positions in that department)
    positions = ASSEMBLY_POSITIONS if dept == ASSEMBLY_DEPT else None
    return dept, positions


def _position_clause(positions):
    """SQL fragment + params for the position filter (None = no restriction)."""
    if positions is None:
        return "", {}
    return ("AND REPLACE(UPPER(TRIM(COALESCE(position, ''))), ' ', '') = ANY(:positions)",
            {"positions": positions})


@data_bp.route("/api/line-transition-candidates", methods=["GET"])
@line_leader_required
def get_line_transition_candidates():
    """Eligible employees for one selected source line, scoped to the leader's department."""
    target_raw = (request.args.get("target_line") or "").strip()
    line = _line_transition_access(target_raw)
    source_line = (request.args.get("source_line") or "").strip()
    if not line:
        return jsonify({"success": False, "message": "forbidden"}), 403

    src_key = _extract_line_key(source_line.upper()) if source_line else ""
    if (not source_line
            or source_line.upper() == target_raw.upper()
            or (src_key and src_key == line)):
        return jsonify({"success": False, "message": "Choose a different source line."}), 400

    with db.engine.connect() as conn:
        dept, positions = _transition_scope(conn, target_raw)
        pos_sql, pos_params = _position_clause(positions)
        params = {"source_line": source_line, "dept": dept,
                  "excluded": EXCLUDED_TRANSITION_LINES, **pos_params}
        rows = conn.execute(sa_text("""
            SELECT emp_id, full_name, line_name, process, department, position
            FROM frontend.employee_groupings
            WHERE COALESCE(employee_status, 'ACTIVE') <> 'INACTIVE'
              AND UPPER(TRIM(line_name)) = UPPER(TRIM(:source_line))
              AND UPPER(TRIM(line_name)) <> ALL(:excluded)
              AND UPPER(REPLACE(TRIM(COALESCE(department, '')), ' ', '')) = :dept
              {pos_sql}
            ORDER BY full_name, line_name
        """.format(pos_sql=pos_sql)), params).mappings().all()

    candidates = []
    for row in rows:
        candidates.append({
            "id": str(row["emp_id"] or "").strip(),
            "name": str(row["full_name"] or "Unknown").strip(),
            "line_name": str(row["line_name"] or "").strip(),
            "process": str(row["process"] or "").strip(),
            "position": str(row["position"] or "").strip(),
        })
    return jsonify({"success": True, "candidates": candidates})


@data_bp.route("/api/line-transition-source-lines", methods=["GET"])
@line_leader_required
def get_line_transition_source_lines():
    """Lines the leader can borrow employees from (same department only)."""
    target_raw = (request.args.get("target_line") or "").strip()
    line = _line_transition_access(target_raw)
    if not line:
        return jsonify({"success": False, "message": "forbidden"}), 403

    with db.engine.connect() as conn:
        dept, positions = _transition_scope(conn, target_raw)
        pos_sql, pos_params = _position_clause(positions)
        rows = conn.execute(sa_text("""
            SELECT DISTINCT TRIM(line_name) AS line_name
            FROM frontend.employee_groupings
            WHERE COALESCE(employee_status, 'ACTIVE') <> 'INACTIVE'
              AND TRIM(COALESCE(line_name, '')) <> ''
              AND UPPER(TRIM(line_name)) <> ALL(:excluded)
              AND UPPER(REPLACE(TRIM(COALESCE(department, '')), ' ', '')) = :dept
              {pos_sql}
            ORDER BY 1
        """.format(pos_sql=pos_sql)),
            {"dept": dept, "excluded": EXCLUDED_TRANSITION_LINES, **pos_params}).mappings().all()

    lines = []
    for r in rows:
        name = (r["line_name"] or "").strip()
        if not name or name.upper() == target_raw.upper():
            continue
        key = _extract_line_key(name.upper())
        if key and key == line:
            continue
        lines.append(name)
    return jsonify({"success": True, "lines": lines})


# Backing table (create once):
#
#   CREATE TABLE IF NOT EXISTS frontend.line_layouts (
#       line       TEXT PRIMARY KEY,
#       stations   JSONB NOT NULL,
#       updated_by TEXT,
#       updated_at TIMESTAMP DEFAULT NOW()
#   );
#
# `stations` mirrors the JS-side station shape used by
# LINE_FLOOR_PLANS / renderLineFloorPlan on the dashboard:
#   [{ "label": "Feeder", "x": 20, "y": 310, "w": 160, "h": 300,
#      "aliases": ["FEEDER"] }, ...]

@data_bp.route("/api/line-layout", methods=["GET"])
@login_required
def get_line_layout():
    raw_line = (request.args.get("line") or "").strip().upper()
    if not raw_line:
        return jsonify({"success": False, "message": "line is required"}), 400

    # NEW: normalize to the same canonical key used everywhere else for
    # line matching (_extract_line_key), so it doesn't matter whether the
    # caller passes assigned_line ("LINE 2 DS") or a raw roster line_name
    # ("L2 DS") — both resolve to the same DB row ("LINE 2"). "__DEFAULT__"
    # is a sentinel value, not a real line name, so it's left untouched.
    line = raw_line if raw_line == "__DEFAULT__" else _extract_line_key(raw_line)

    role = role_context().get("role_info", {})   # ← unwrap the nested key
    # LINE-level users can only fetch their own assigned line's layout,
    # EXCEPT "__DEFAULT__" — everyone is allowed to READ the company-wide
    # default layout (write access to it is still admin/section/global-only,
    # enforced separately in save_line_layout above).
    if line != "__DEFAULT__" and role.get("access_level") == "LINE" and not role.get("is_admin"):
        assigned_key = _extract_line_key((role.get("assigned_line") or "").strip().upper())
        if assigned_key != line:
            return jsonify({"success": False, "message": "forbidden"}), 403

    with db.engine.connect() as conn:
        row = conn.execute(sa_text("""
            SELECT stations FROM frontend.line_layouts WHERE line = :line
        """), {"line": line}).mappings().first()

    return jsonify(row["stations"] if row else None)


@data_bp.route("/api/line-layout", methods=["POST"])
@login_required
def save_line_layout():
    role = role_context().get("role_info", {})   # ← unwrap the nested key
    payload = request.get_json(silent=True) or {}
    raw_line = (payload.get("line") or "").strip().upper()
    stations = payload.get("stations")

    if not raw_line:
        return jsonify({"success": False, "message": "line is required"}), 400
    if not isinstance(stations, list):
        return jsonify({"success": False, "message": "stations must be a list"}), 400

    # NEW: same normalization as the GET route — whatever string comes in
    # ("LINE 2 DS", "L2 DS", "Line 2 Night Shift", etc.) collapses to one
    # canonical key ("LINE 2") so every caller reads/writes the same row.
    line = raw_line if raw_line == "__DEFAULT__" else _extract_line_key(raw_line)

    # TEMPORARY: pinapayagan muna ang Line Leaders na mag-save ng "__DEFAULT__"
    # layout habang ginagawa yung initial company-wide arrangement.
    # TODO: TANGGALIN ITONG BLOCK PAGKATAPOS MA-FINALIZE ANG DEFAULT LAYOUT —
    # ibalik yung dating restriction (admin/SECTION/GLOBAL only para sa __DEFAULT__).
    is_line_level = role.get("access_level") == "LINE" and not role.get("is_admin")
    if is_line_level:
        if line == "__DEFAULT__":
            pass  # TEMPORARY: allowed muna — dapat i-block ulit ito mamaya
        else:
            assigned_key = _extract_line_key((role.get("assigned_line") or "").strip().upper())
            if assigned_key != line:
                return jsonify({"success": False, "message": "You can only edit your own line's layout."}), 403
    elif not (role.get("is_admin") or role.get("access_level") in ("SECTION", "GLOBAL")):
        return jsonify({"success": False, "message": "forbidden"}), 403

    with db.engine.begin() as conn:
        conn.execute(sa_text("""
            INSERT INTO frontend.line_layouts (line, stations, updated_by, updated_at)
            VALUES (:line, :stations, :updated_by, NOW())
            ON CONFLICT (line) DO UPDATE
            SET stations = EXCLUDED.stations,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
        """), {
            "line": line,
            "stations": json.dumps(stations),
            "updated_by": current_username(),
        })

    return jsonify({"success": True})

LINE_PRODUCT_NAME_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "line_product_names.json")
_line_product_name_lock = threading.Lock()


def _read_line_product_names() -> dict:
    try:
        with open(LINE_PRODUCT_NAME_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_line_product_names(data_dict: dict) -> None:
    os.makedirs(os.path.dirname(LINE_PRODUCT_NAME_FILE), exist_ok=True)
    tmp_path = LINE_PRODUCT_NAME_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data_dict, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, LINE_PRODUCT_NAME_FILE)  # atomic swap, avoids partial writes


@data_bp.route("/api/line-product-name", methods=["GET"])
@login_required
def get_line_product_name():
    raw_line = (request.args.get("line") or "").strip().upper()
    if not raw_line:
        return jsonify({"success": False, "message": "line is required"}), 400

    # NEW: same normalization as /api/line-layout — so "L2 DS" (raw roster
    # line_name, used by the Supervisor peek view) resolves to the same
    # key ("LINE 2") as whatever the Line Leader's assigned_line saved
    # the product name under.
    line = _extract_line_key(raw_line)

    role = role_context().get("role_info", {})
    if role.get("access_level") == "LINE" and not role.get("is_admin"):
        assigned_key = _extract_line_key((role.get("assigned_line") or "").strip().upper())
        if assigned_key != line:
            return jsonify({"success": False, "message": "forbidden"}), 403

    with _line_product_name_lock:
        names = _read_line_product_names()

    return jsonify({"product_name": names.get(line, "")})

@data_bp.route("/api/line-product-name", methods=["POST"])
@login_required
def save_line_product_name():
    role = role_context().get("role_info", {})
    payload = request.get_json(silent=True) or {}
    raw_line = (payload.get("line") or "").strip().upper()
    product_name = (payload.get("product_name") or "").strip()

    if not raw_line:
        return jsonify({"success": False, "message": "line is required"}), 400
    if len(product_name) > 200:
        return jsonify({"success": False, "message": "product_name is too long"}), 400

    # NEW: same normalization as GET above
    line = _extract_line_key(raw_line)

    is_line_level = role.get("access_level") == "LINE" and not role.get("is_admin")
    if is_line_level:
        assigned_key = _extract_line_key((role.get("assigned_line") or "").strip().upper())
        if assigned_key != line:
            return jsonify({"success": False, "message": "You can only edit your own line's product name."}), 403
    elif not (role.get("is_admin") or role.get("access_level") in ("SECTION", "GLOBAL")):
        return jsonify({"success": False, "message": "forbidden"}), 403

    with _line_product_name_lock:
        names = _read_line_product_names()
        names[line] = product_name
        _write_line_product_names(names)
        return jsonify({"success": True, "product_name": product_name})