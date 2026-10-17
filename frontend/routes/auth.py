from functools import wraps
import re

from flask import Blueprint, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import text as sa_text
from sqlalchemy.exc import IntegrityError
import traceback

from routes.extensions import db
from routes.decorators import login_required, admin_required

auth_bp = Blueprint("auth", __name__)

# Must match the DB check constraint: frontend.users_roles_check
ROLES = {"Admin", "Supervisor", "Viewer"}
DEFAULT_ROLE = "Viewer"

# Must match the DB check constraint: frontend.users_department_check
DEPARTMENTS = {"PRODUCTION", "TECHNICAL", "QUALITY", "ADMINISTRATION"}

# Must match the DB check constraint: frontend.users_access_level_check
# LINE       - Level 1: single line only (e.g. "Line 7 DS"). Supported for
#              PRODUCTION and QUALITY today — both have line leaders.
# SECTION    - Level 2: a whole Production sub-section (e.g. Production-Assembly).
#              Production-only today — Quality has no named sub-sections.
# DEPARTMENT - Level 3: whole assigned department (today's pre-existing behavior)
# GLOBAL     - Level 4: HR / unrestricted (Admin role, or ADMINISTRATION department)
ACCESS_LEVELS = {"LINE", "SECTION", "DEPARTMENT", "GLOBAL"}
DEFAULT_ACCESS_LEVEL = "DEPARTMENT"

# Sub-sections currently only exist under PRODUCTION. If Quality/Technical
# ever get sub-sections, extend this set (and the DB check constraint) —
# nothing else in this file assumes PRODUCTION specifically except this set.
PRODUCTION_SECTIONS = {"ASSEMBLY", "WH", "CC"}

# Departments whose users can be scoped down to a single LINE (Level 1).
# Production has always supported this; Quality also has line leaders and
# is scoped the same way — one line + one shift identifies their sheet,
# exactly like Production's Line-level users.
LINE_LEVEL_DEPARTMENTS = {"PRODUCTION", "QUALITY"}

# Departments whose users can be scoped down to a named SECTION (Level 2).
# Production-only today: PRODUCTION_SECTIONS (Assembly/Warehouse/CC) don't
# have a Quality equivalent yet.
SECTION_LEVEL_DEPARTMENTS = {"PRODUCTION"}

# Extra sections a SECTION-level user may see, but ONLY inside the listed
# sheets (matched by line_name). Keyed by username (case-insensitive).
# Edit this to grant/revoke; no DB change needed.
SECTION_EXTRA_ACCESS = {
    "adminp": {                          # Arlene Auza
        "sections": {"WH", "CC"},        # extra sections she may see...
        "lines":    {"ADMIN DS", "ADMIN NS"},  # ...but only in these sheets
    },
}


def _norm_line_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().upper())


def _user_sections(user, line_name: str = None) -> set:
    """Sections a SECTION-level user may see for a given sheet/line.
    Always includes their own assigned_section; the SECTION_EXTRA_ACCESS
    sections are added only when `line_name` is one of the granted sheets."""
    sections = set()
    primary = (user.get("assigned_section") or "").strip().upper()
    if primary:
        sections.add(primary)

    username = (user.get("username") or "").strip().lower()
    grant = SECTION_EXTRA_ACCESS.get(username)
    if grant:
        granted_lines = {_norm_line_name(l) for l in grant.get("lines", set())}
        if _norm_line_name(line_name) in granted_lines:
            sections |= {s.upper() for s in grant.get("sections", set())}
    return sections

# ── Department visibility rules ─────────────────────────────────────────────
# Used to filter which employee/attendance records a logged-in user is
# allowed to see (and, downstream, which Time-In requests they're allowed
# to approve/decline/edit).
#
#   Level 4 (GLOBAL)     - Admin role, or ADMINISTRATION-department users
#                           (HR): unrestricted visibility across ALL
#                           departments/sections/lines. Applies everywhere:
#                           the employee directory, both approval-queue
#                           stages, and any notifications/metadata derived
#                           from attendance data. Unchanged from before.
#   Level 3 (DEPARTMENT) - sees everything in their own department. This is
#                           the pre-existing whole-department behavior for
#                           QUALITY / TECHNICAL / PRODUCTION users.
#   Level 2 (SECTION)    - PRODUCTION users only: sees only employees whose
#                           parsed department sub-section matches their own
#                           assigned_section (e.g. "ASSEMBLY").
#   Level 1 (LINE)       - PRODUCTION and QUALITY users: sees only employees
#                           on their own assigned_line + assigned_shift
#                           (e.g. "Line 7 DS"). Both departments have line
#                           leaders scoped this way; Quality just has no
#                           Level 2 tier beneath it.
#   Unknown/missing department: default deny (sees nothing).
QUALITY_DEPTS   = {"QUALITY", "PRODUCTION-QUALITY"}  # legacy compound, kept for backward compat
TECHNICAL_DEPTS = {"TECHNICAL"}

def _extract_line_key(line_name: str) -> str:
    s = (line_name or "").strip().upper()

    match = re.match(r"^L\s*-?\s*(\d+)\s+(\d+)(?:ST|ND|RD|TH)\b", s)
    if match:
        return f"LINE {match.group(1)}-{match.group(2)}"

    match = re.match(r"^L\s*-?\s*(\d+)\b", s)
    if match:
        return f"LINE {match.group(1)}"

    match = re.match(r"^([A-Z]+)(\d+)\s*(?:-|LINE)\s*(\d+)", s)
    if match:
        return f"{match.group(1)}{match.group(2)}-{match.group(3)}"

    # FIX: plant-area sheet names like "P2 L1 DS" / "P2 L3 NS" (area code +
    # line number). Without this they fell through to the bare area-code
    # rule below and ALL collapsed to "P2", so leaders of different lines
    # in the same shift (P2 L1 DS + P2 L2 DS, P2 L2 NS + P2 L3 NS) saw
    # each other's groups merged. Keep the line number in the key
    # ("P2-1"); _line_key_covers still lets a plain "P2" account broad-match.
    match = re.match(r"^([A-Z]+\d+)\s*-?\s*L(?:INE)?\s*-?\s*(\d+)\b", s)
    if match:
        return f"{match.group(1)}-{match.group(2)}"

    # FIX: plant-area sheets named after a PRODUCT/PROCESS instead of a line
    # number — e.g. "P3 MX5 DS" and "P3 SENSOR CABLE DS". Without this both
    # fell into the bare area-code rule below and collapsed to "P3", so the
    # P3 MX5 leader also received the P3 Sensor Cable sheet (and vice versa).
    # Keep the product name in the key ("P3-MX5", "P3-SENSOR CABLE"); a plain
    # "P3" account still broad-matches both via _line_key_covers. The shift
    # token is stripped here because shift is checked separately.
    base = re.sub(r"\s+(DAY\s*SHIFT|NIGHT\s*SHIFT|DS|NS|DAY|NIGHT)\s*$", "", s).strip()
    match = re.match(r"^([A-Z]+\d+)\s*([A-Z][A-Z0-9+ ]*)$", base)
    if match:
        product = re.sub(r"\s+", " ", match.group(2)).strip()
        return f"{match.group(1)}-{product}"

    match = re.match(r"^([A-Z]+)(\d+)\b", s)
    if match:
        return f"{match.group(1)}{match.group(2)}"

    match = re.search(r"\bLINE\s*(\d+)", s)
    if match:
        return f"LINE {match.group(1)}"

    match = re.search(r"\b([A-Z]+\d+)\s*-\s*(\d+)\b", s)
    if match:
        return f"{match.group(1)}-{match.group(2)}"

    # NEW: process-area-named "lines" with no numeric code at all — used
    # by the CC section (e.g. "Crimping DS", "Feeder NS", "Cutting DS").
    # Strip a trailing shift token so both shifts of the same process
    # area collapse to one key ("CRIMPING"). The shift itself is still
    # checked separately via assigned_shift/_shift_covers, so this
    # doesn't loosen shift-level isolation — it only fixes the line key.
    fallback = re.sub(r"\s+(DAY\s*SHIFT|NIGHT\s*SHIFT|DS|NS|DAY|NIGHT)\s*$", "", s).strip()
    return fallback or s

def _line_key_covers(assigned_line: str, target_line_key: str) -> bool:
    assigned_key = _extract_line_key(assigned_line)
    if not assigned_key:
        return False
    if assigned_key == target_line_key:
        return True

    # NEW: "LINE N"-style keys never have sub-levels — enforce the
    # docstring's own promise. Only area-coded keys (e.g. "P2") are
    # allowed to broad-match a "-N" suffix.
    if assigned_key.startswith("LINE "):
        return False

    return target_line_key.startswith(assigned_key + "-")


def parse_employee_department(raw_department: str):
    """Parses an employee record's raw `department` string (as it comes out
    of the Excel import, e.g. "PRODUCTION-ASSEMBLY") into (department, section).

    `section` is None unless the department is PRODUCTION and a recognized
    sub-section suffix is present. This is intentionally distinct from the
    employee's job-title/process `section` field (e.g. "Finishing",
    "SR.LEADER") used elsewhere for line-card grouping — that field is NOT
    used for access control and must not be confused with this one.
    """
    d = (raw_department or "").strip().upper()

    if d in QUALITY_DEPTS:
        return "QUALITY", None
    if d in TECHNICAL_DEPTS:
        return "TECHNICAL", None
    if d == "ADMINISTRATION":
        return "ADMINISTRATION", None

    if d.startswith("PRODUCTION-"):
        suffix = d.split("-", 1)[1]
        return "PRODUCTION", suffix if suffix in PRODUCTION_SECTIONS else None

    if d == "PRODUCTION":
        return "PRODUCTION", None

    # Unknown/missing/garbage department string: treat as PRODUCTION with no
    # section, same catch-all fallback as the old classifyDepartment() had.
    return "PRODUCTION", None


def _line_shift_match(emp: dict, user: dict) -> bool:
    assigned_line  = (user.get("assigned_line") or "").strip().upper()
    assigned_shift = (user.get("assigned_shift") or "").strip().upper()
    emp_line  = (emp.get("line_name") or "").strip().upper()
    emp_shift = (emp.get("shift") or "").strip().upper()
    return bool(assigned_line) and bool(assigned_shift) \
        and _line_key_covers(assigned_line, _extract_line_key(emp_line)) \
        and _shift_covers(assigned_shift, _normalize_shift(emp_shift))


def _normalize_shift(shift: str) -> str:
    """Normalizes shift values into a canonical DAY/NIGHT/BOTH form. The
    Excel import stores short codes ("DS", "NS") in the roster, while
    other sources (attendance logs, assigned_shift from /api/me) may use
    the full name ("Day Shift", "Night Shift"). Without this, an employee
    who hasn't checked in yet today (and so falls back to the roster's
    "DS") never matches a LINE-scoped user's assigned_shift of "Day
    Shift", and silently drops out of that user's view.

    "BOTH" is a user-only value (an account's assigned_shift can be set to
    it via registration) meaning "this account is not restricted to a
    single shift on their line" — see _shift_covers below. Employee/roster
    shift values are always a single concrete shift and never normalize to
    "BOTH".
    """
    s = (shift or "").strip().upper()
    if s in ("BOTH", "BOTH SHIFTS", "ALL SHIFTS", "ALL", "DAY & NIGHT", "DAY AND NIGHT"):
        return "BOTH"
    if s in ("DS", "DAY", "DAY SHIFT", "D"):
        return "DAY"
    if s in ("NS", "NIGHT", "NIGHT SHIFT", "N"):
        return "NIGHT"
    if "NIGHT" in s:
        return "NIGHT"
    if "DAY" in s:
        return "DAY"
    return s


def _shift_covers(assigned_shift: str, target_shift_norm: str) -> bool:
    """True if a user's assigned_shift covers a target shift value (which
    should already be normalized, e.g. via _normalize_shift). An
    assigned_shift of "Both Shifts" covers any concrete shift; otherwise
    it must match exactly (DAY==DAY, NIGHT==NIGHT).
    """
    assigned_norm = _normalize_shift(assigned_shift)
    if assigned_norm == "BOTH":
        return True
    return assigned_norm == target_shift_norm


def can_view_employee(emp: dict, user: dict = None) -> bool:
    """Given an employee record (must include raw 'department' and, for
    Line-level checks, 'line_name'/'shift'), returns whether the given user
    is allowed to see/act on that employee.

    THIS IS THE SINGLE SOURCE OF TRUTH FOR DEPARTMENT/SECTION/LINE
    VISIBILITY (the 4-tier matrix). Every route that returns employee,
    attendance, or Time-In-request data — /api/attendance-logs,
    /api/employee-groupings, /api/data, /api/attendance/time-in-requests
    (list/first-approve/approve/decline), /api/no-work, and any
    attendance-history or notification endpoint — MUST call this (or
    filter with it) server-side before the data leaves the server, and
    MUST also use it to validate any employee_id(s) submitted in a
    write/POST/PUT payload before acting on them. The client-side mirror
    in attendance_logs.js / employee_management.js is a UX/rendering
    convenience only; it is trivially bypassed via devtools or curl and
    provides no real access control.

        employees = [e for e in employees if can_view_employee(e)]

    `user` defaults to the Flask session; pass an explicit dict (with keys
    role/department/access_level/assigned_line/assigned_shift/assigned_section)
    for testing or for contexts outside a request.
    """
    user = user if user is not None else session

    role       = user.get("role")
    is_admin   = role == "Admin"
    user_dept  = (user.get("department") or "").strip().upper()

    # Level 4 — GLOBAL / HR: unrestricted, regardless of access_level.
    if is_admin or user_dept == "ADMINISTRATION":
        return True

    emp_dept, emp_section = parse_employee_department(emp.get("department"))

    # TECHNICAL has no defined sub-tiers in the spec — stays whole-department
    # (Level 3) regardless of whatever access_level happens to be stored.
    if user_dept == "TECHNICAL":
        return emp_dept == "TECHNICAL"

    if user_dept == "QUALITY":
        if emp_dept != "QUALITY":
            return False

        access_level = (user.get("access_level") or DEFAULT_ACCESS_LEVEL).strip().upper()

        if access_level == "DEPARTMENT" or access_level == "GLOBAL":
            return True
        if access_level == "LINE":
            return _line_shift_match(emp, user)
        # SECTION isn't defined for Quality today — unrecognized/SECTION
        # access_level on a Quality account defaults to deny rather than
        # silently granting whole-department visibility.
        return False

    if user_dept == "PRODUCTION":
        if emp_dept != "PRODUCTION":
            return False

        access_level = (user.get("access_level") or DEFAULT_ACCESS_LEVEL).strip().upper()

        if access_level == "DEPARTMENT" or access_level == "GLOBAL":
            # A PRODUCTION user should never actually carry GLOBAL, but treat
            # it as department-wide rather than silently denying if it happens.
            return True
        if access_level == "SECTION":
            allowed = _user_sections(user, emp.get("line_name"))
            return bool(allowed) and emp_section in allowed
        if access_level == "LINE":
            return _line_shift_match(emp, user)

        return False  # unrecognized access_level: default deny

    return False  # unknown/missing user department: default deny


def can_view_department(emp_department: str, user_department: str, is_admin: bool = False) -> bool:
    """DEPRECATED — kept only so existing `from routes.auth import
    can_view_department` call sites (e.g. attendance.py, data.py) don't
    break on import. This preserves the OLD, coarser Level-3-only behavior:
    it has no way to check Line/Section (Levels 1-2) or GLOBAL beyond
    Administration, because it was never given the calling user's
    access_level/assigned_line/assigned_section, and it can't see the
    employee's line_name either.

    Any route still calling this only enforces whole-department visibility
    — a Production or Quality user scoped to Level 1 (Line), or a
    Production user scoped to Level 2 (Section), will incorrectly see
    their WHOLE department through this path. Replace each call site with
    can_view_employee(emp) (per-employee, needs 'department' and
    'line_name'/'shift' keys) and can_view_group(group) (per-sheet) to get
    the real 4-tier behavior. Share attendance.py/data.py and I'll do that
    replacement directly instead of leaving this shim in place.
    """
    if is_admin:
        return True

    emp_dept, _  = parse_employee_department(emp_department)
    user_dept    = (user_department or "").strip().upper()

    if user_dept == "ADMINISTRATION":
        return True
    if user_dept == "QUALITY":
        return emp_dept == "QUALITY"
    if user_dept == "TECHNICAL":
        return emp_dept == "TECHNICAL"
    if user_dept == "PRODUCTION":
        return emp_dept == "PRODUCTION"

    return False


def can_view_group(group: dict, user: dict = None) -> bool:
    """Given a whole line/sheet group (must include 'line_name', 'shift', and
    its 'employees' list), returns whether the user should even receive this
    sheet at all.

    This matters because can_view_employee() alone only filters which
    EMPLOYEES within a sheet a user sees — it does NOT stop a LINE- or
    SECTION-level user's client from receiving OTHER sheets in the same API
    response. A Line 2 Day Shift leader (Production or Quality) must not
    receive the Line 3 or Line 2 Night Shift group objects at all, not just
    have their employees hidden client-side.

    Call this to filter state.data.groups server-side, in whatever route
    backs /api/employee-groupings (or equivalent), BEFORE can_view_employee
    is applied to the employees inside each surviving group. The Unassigned
    bucket should be dropped entirely for LINE and SECTION level users,
    since it isn't scoped to any one line/section.
    """
    user = user if user is not None else session
    role      = user.get("role")
    is_admin  = role == "Admin"
    user_dept = (user.get("department") or "").strip().upper()

    if is_admin or user_dept == "ADMINISTRATION":
        return True

    access_level = (user.get("access_level") or DEFAULT_ACCESS_LEVEL).strip().upper()

    def _group_has_dept_employee(target_dept: str, section: str = None) -> bool:
        """A sheet can mix employees from more than one department (or, for
        Production, more than one section) — so DEPARTMENT/whole-department
        visibility must check actual membership, not just assume every
        sheet belongs to the viewer's department. Without this, a sheet
        with zero matching employees still got returned (just emptied out
        by can_view_employee afterward), leaking other departments'
        line cards as "0 Employees" cards instead of being dropped."""
        for emp in group.get("employees", []):
            emp_dept, emp_section = parse_employee_department(emp.get("department"))
            if emp_dept != target_dept:
                continue
            if section is not None and emp_section != section:
                continue
            return True
        return False

    # TECHNICAL has no sub-tiers, but the sheet still needs an actual
    # TECHNICAL employee in it to be shown.
    if user_dept == "TECHNICAL":
        return _group_has_dept_employee("TECHNICAL")

    # DEPARTMENT-level (and GLOBAL) get every sheet that has at least one
    # employee in their own department; can_view_employee still filters
    # remaining individual employees for any mismatches left in it.
    if access_level in ("DEPARTMENT", "GLOBAL"):
        return _group_has_dept_employee(user_dept)

    if user_dept not in LINE_LEVEL_DEPARTMENTS:
        # Neither Production nor Quality, and not caught by DEPARTMENT/GLOBAL
        # above (e.g. a LINE/SECTION access_level stored on some other
        # department by mistake) — default deny.
        return False

    group_line  = (group.get("line_name") or "").strip().upper()
    group_shift = (group.get("shift") or "").strip().upper()

    if access_level == "LINE":
        assigned_line  = (user.get("assigned_line") or "").strip().upper()
        assigned_shift = (user.get("assigned_shift") or "").strip().upper()
        return bool(assigned_line) and bool(assigned_shift) \
            and _line_key_covers(assigned_line, _extract_line_key(group_line)) \
            and _shift_covers(assigned_shift, _normalize_shift(group_shift))

    if access_level == "SECTION" and user_dept in SECTION_LEVEL_DEPARTMENTS:
        # A sheet can contain employees from more than one section, so keep
        # the sheet if ANY of its employees fall in the user's section —
        # can_view_employee() will still hide the other employees within it.
        allowed = _user_sections(user, group.get("line_name"))
        if not allowed:
            return False
        for emp in group.get("employees", []):
            _, emp_section = parse_employee_department(emp.get("department"))
            if emp_section in allowed:
                return True
        return False

    return False


def is_hr_approver(role: str = None, department: str = None) -> bool:
    """True for accounts allowed to act on the FINAL (HR / Stage 2)
    Time-In approval queue: Admins, and anyone in the ADMINISTRATION
    department (Level 4 / GLOBAL). Everyone else — including Production
    and Quality users regardless of their Line/Section/Department
    access_level, and Technical users — must never see Stage 2 data,
    counts, or notifications.

    This is the SOLE gate on the HR/final-approval queue. There is no
    additional password step — an Administration-department or Admin
    account gets access outright; everyone else is denied outright.
    """
    role = role if role is not None else session.get("role")
    department = (department if department is not None else session.get("department")) or ""
    return role == "Admin" or department.strip().upper() == "ADMINISTRATION"


def can_declare_no_work(role: str = None, department: str = None) -> bool:
    """True for accounts allowed to declare/clear "No Work" entries for
    employees within their own visibility scope: Admins, HR/Administration
    (who are unrestricted anyway), and any Supervisor — regardless of that
    Supervisor's department or access_level (LINE/SECTION/DEPARTMENT).

    This is intentionally narrower than department_unrestricted/is_hr_approver:
    a Supervisor gets this ONE action, not full employee management (no add/
    edit/delete/leave/separate/rehire) and not cross-department visibility.
    The employee(s) a Supervisor can actually target with it are still
    constrained by can_view_employee() — this function only answers "is this
    role allowed to use the No Work feature at all", not "for which
    employees". Both checks are required together wherever No Work is
    enforced server-side (see the /api/no-work route).
    """
    role = role if role is not None else session.get("role")
    department = (department if department is not None else session.get("department")) or ""
    return role == "Admin" or role == "Supervisor" or is_hr_approver(role, department)


def can_bulk_delete(role: str = None, access_level: str = None) -> bool:
    """True for accounts allowed to run bulk employee deletion.

    Only Levels 2–4 (SECTION, DEPARTMENT, GLOBAL) may use
    /api/employees/bulk-delete.  Admin remains an explicit legacy fallback
    when an older Admin session has no stored access level.
    """
    role = role if role is not None else session.get("role")
    access_level = (access_level if access_level is not None
                     else session.get("access_level") or DEFAULT_ACCESS_LEVEL)
    access_level = (access_level or "").strip().upper()

    # Keep the policy explicit.  A missing or malformed tier must not gain
    # deletion rights merely because it is not literally "LINE".  The Admin
    # fallback preserves access for legacy Admin sessions that predate the
    # access_level field.
    return role == "Admin" or access_level in {"SECTION", "DEPARTMENT", "GLOBAL"}


def can_manage_employees_check(role: str = None, access_level: str = None) -> bool:
    """True for accounts allowed to manage employee assignment data —
    e.g. manual line/shift/process moves. Levels 2-4 (SECTION/DEPARTMENT/
    GLOBAL access_level) and Admins. Line Leaders (LINE-level) are
    blocked. Mirrors the can_manage_employees flag already exposed via
    role_context()/api/me — this is the same policy, just callable from a
    route decorator.
    """
    role = role if role is not None else session.get("role")
    access_level = (access_level if access_level is not None
                     else session.get("access_level") or DEFAULT_ACCESS_LEVEL)
    access_level = (access_level or "").strip().upper()
    return role == "Admin" or access_level in {"SECTION", "DEPARTMENT", "GLOBAL"}


def hr_approval_required(f):
    """Route decorator that restricts access to HR/final-approval-only
    endpoints. Apply this to every server route backing the "Pending
    Time-In Requests (Final / HR Approval)" modal:
      - GET  /api/attendance/time-in-requests?status=Pending HR Approval
      - PUT  /api/attendance/time-in-requests/<id>/approve
      - PUT  /api/attendance/time-in-requests/<id>/decline   (when the
             request being declined is in the Pending HR Approval stage)

    This is what makes the HR gate real: the client-side UI (button
    visibility) is just UX. Without this decorator on the server routes, a
    Production/Quality/Technical user could hit those endpoints directly
    (devtools/curl) and read or act on HR-stage requests for every
    department, defeating cross-department isolation.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"success": False, "message": "Login required."}), 401
        if not is_hr_approver():
            return jsonify({"success": False, "message": "HR/Administration access required."}), 403
        return f(*args, **kwargs)
    return wrapper


def no_work_access_required(f):
    """Route decorator for the No Work endpoints (/api/no-work: POST list/
    create, DELETE). Confirms the caller's ROLE is allowed to use the
    feature at all (Admin / Supervisor / HR-Administration).

    IMPORTANT: this only gates the ACTION, not the employees it's applied
    to. Every handler using this decorator MUST additionally filter/
    validate the target emp_id(s) against can_view_employee() for the
    current session before reading or writing any No Work row, so a
    Supervisor in one department/line can't declare No Work for employees
    outside their own visibility scope. See can_view_employee()'s
    docstring — /api/no-work is listed there as a required call site.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"success": False, "message": "Login required."}), 401
        if not can_declare_no_work():
            return jsonify({"success": False, "message": "Supervisor, Admin, or Administration access required."}), 403
        return f(*args, **kwargs)
    return wrapper


def bulk_delete_required(f):
    """Route decorator for /api/employees/bulk-delete.

    Enforces the Level 1-4 rule server-side: Line Leaders (LINE-level
    access) are STRICTLY BLOCKED from bulk deletion, even if they somehow
    still have a valid session and try to hit this endpoint directly via
    devtools/curl. Levels 2-4 (SECTION/DEPARTMENT/GLOBAL access_level) and
    Admins are authorized.

    The client-side button hiding in employee_management.js
    (data-can-bulk-delete) is UX only — this decorator is the actual
    enforcement point, exactly like hr_approval_required and
    no_work_access_required above. Without it, a Line Leader account
    could still call /api/employees/bulk-delete directly and delete
    employees outside (or even within) their own line.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"success": False, "message": "Login required."}), 401
        if not can_bulk_delete():
            return jsonify({
                "success": False,
                "message": "Line Leaders are not authorized to perform bulk deletion.",
            }), 403
        return f(*args, **kwargs)
    return wrapper


def manage_employees_required(f):
    """Route decorator for actions that modify employee assignment data
    (e.g. manual line/shift/process moves, such as /api/manual-move-employee).

    Enforces the same Level 2-4 rule as can_manage_employees in
    role_context()/api/me: SECTION, DEPARTMENT, or GLOBAL access_level, or
    the Admin role. Line Leaders (LINE-level access) are blocked, matching
    the fact that they never see "can_manage_employees: true" on the
    frontend either.

    NOTE: like bulk_delete_required, this only gates the ACTION itself —
    it does not scope which employee(s) can be targeted. Handlers using
    this decorator must still validate the target employee against
    can_view_employee() before reading/writing their record, so a
    SECTION-level user can't move an employee outside their own section.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"success": False, "message": "Login required."}), 401
        if not can_manage_employees_check():
            return jsonify({
                "success": False,
                "message": "Section, Department, Global, or Admin access required.",
            }), 403
        return f(*args, **kwargs)
    return wrapper


def role_context() -> dict:
    """Inject role/department/access-tier info into every rendered template."""
    is_admin = session.get("role") == "Admin"
    role = session.get("role", "")
    department = session.get("department", "")
    access_level = session.get("access_level", DEFAULT_ACCESS_LEVEL)
    can_manage_employees = (
        str(access_level or "").strip().upper() in {"SECTION", "DEPARTMENT", "GLOBAL"}
        or is_admin
    )
    return {
        "role_info": {
            "role":                    role,
            "department":              department,
            "access_level":            access_level,
            "assigned_line":           session.get("assigned_line"),
            "assigned_shift":          session.get("assigned_shift"),
            "assigned_section":        session.get("assigned_section"),
            "is_admin":                is_admin,
            "is_viewer":               not is_admin and session.get("logged_in", False),
            "can_write":               can_manage_employees,
            "can_manage_employees":    can_manage_employees,
            # Administration department (and Admin role) get unrestricted
            # visibility everywhere: directory + both approval stages.
            "department_unrestricted": is_hr_approver(role, department),
            # Supervisors (any department/access_level) may declare/clear
            # No Work for employees within their own visibility scope. This
            # is deliberately separate from department_unrestricted/
            # can_write — a Supervisor is NOT HR and does NOT get full
            # employee management (add/edit/delete/leave/separate/rehire),
            # just this one action. The real gate is server-side, via
            # no_work_access_required + can_view_employee() on the
            # /api/no-work routes — this flag only drives whether the
            # frontend shows the No Work controls.
            "can_declare_no_work":     can_declare_no_work(role, department),
            # Levels 2-4 (or Admin) only. Deliberately separate from
            # can_manage_employees — bulk delete has its OWN, slightly
            # broader gate (SECTION/DEPARTMENT/GLOBAL, not just
            # Admin/Administration), while still hard-blocking Level 1
            # (LINE / Line Leader) outright. Real enforcement is
            # server-side via bulk_delete_required on
            # /api/employees/bulk-delete — this flag only drives whether
            # the frontend shows the Bulk Delete button.
            "can_bulk_delete":         can_bulk_delete(role, access_level),
        }
    }

@auth_bp.after_request
def add_no_cache_headers(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response
# ── Pages ──────────────────────────────────────────────────────────────────
@auth_bp.route("/")
def home():
    return render_template("index.html")


@auth_bp.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html", **role_context())


@auth_bp.route("/maindashboard")
@login_required
def maindashboard():
    return render_template("maindashboard.html", **role_context())


@auth_bp.route("/overtime")
@login_required
def overtime():
    return render_template("overtime.html", **role_context())


@auth_bp.route("/attendance-logs")
@login_required
def attendance_logs_page():
    return render_template("attendance_logs.html", **role_context())


@auth_bp.route("/employee_management")
@login_required
def employee_management():
    return render_template("employee_management.html", **role_context())


@auth_bp.route("/scanner_management")
@admin_required
def scanner_management():
    return render_template("scanner_management.html", **role_context())


# ── Auth routes ────────────────────────────────────────────────────────────
@auth_bp.route("/login", methods=["POST"])
def login():
    try:
        data     = request.get_json(force=True, silent=True) or {}
        username = data.get("username", "").strip()
        password = data.get("password", "")

        if not username or not password:
            return jsonify({"success": False, "message": "Username and password are required."})

        with db.engine.connect() as conn:
            row = conn.execute(sa_text(
                "SELECT username, password_hash, first_name, last_name, roles, department, "
                "       access_level, assigned_line, assigned_shift, assigned_section "
                "FROM frontend.users WHERE username = :username LIMIT 1"
            ), {"username": username}).fetchone()

        if not row or not check_password_hash(row.password_hash, password):
            return jsonify({"success": False, "message": "Invalid username or password."})

        session["logged_in"]        = True
        session["username"]         = row.username
        session["first_name"]       = row.first_name
        session["last_name"]        = row.last_name
        session["role"]             = row.roles
        session["department"]       = row.department
        session["access_level"]     = row.access_level
        session["assigned_line"]    = row.assigned_line
        session["assigned_shift"]   = row.assigned_shift
        session["assigned_section"] = row.assigned_section

        return jsonify({
            "success":         True,
            "role":            row.roles,
            "department":      row.department,
            "access_level":    row.access_level,
            "assigned_line":   row.assigned_line,
            "assigned_shift":  row.assigned_shift,
            "assigned_section": row.assigned_section,
            "is_admin":        row.roles == "Admin",
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Server error: {str(e)}"}), 500


@auth_bp.route("/register", methods=["POST"])
def register():
    try:
        data             = request.get_json(force=True, silent=True) or {}
        first_name       = data.get("first_name", "").strip()
        last_name        = data.get("last_name",  "").strip()
        username         = data.get("username",   "").strip()
        password         = data.get("password",   "")
        roles            = data.get("roles",      DEFAULT_ROLE).strip()
        department       = data.get("department", "").strip().upper()
        access_level     = data.get("access_level", DEFAULT_ACCESS_LEVEL).strip().upper()
        assigned_line    = (data.get("assigned_line") or "").strip() or None
        assigned_shift   = (data.get("assigned_shift") or "").strip() or None
        assigned_section = (data.get("assigned_section") or "").strip().upper() or None

        if not all([first_name, last_name, username, password, department]):
            return jsonify({"success": False, "message": "All fields are required."})

        if len(password) < 6:
            return jsonify({"success": False, "message": "Password must be at least 6 characters."})
        if roles not in ROLES:
            return jsonify({"success": False, "message": f"Invalid role. Must be one of: {sorted(ROLES)}"}), 400
        if department not in DEPARTMENTS:
            return jsonify({"success": False, "message": f"Invalid department. Must be one of: {sorted(DEPARTMENTS)}"}), 400
        if access_level not in ACCESS_LEVELS:
            return jsonify({"success": False, "message": f"Invalid access level. Must be one of: {sorted(ACCESS_LEVELS)}"}), 400

        # GLOBAL is implicit for Admin role / Administration department only —
        # don't let an arbitrary account grant itself Level 4 visibility.
        if access_level == "GLOBAL" and roles != "Admin" and department != "ADMINISTRATION":
            return jsonify({"success": False, "message": "GLOBAL access is reserved for Admin or Administration accounts."}), 400

        # LINE tier (Level 1) applies to Production and Quality — both have
        # line leaders. SECTION tier (Level 2) is Production-only today,
        # since Quality has no named sub-sections yet.
        if access_level == "LINE" and department not in LINE_LEVEL_DEPARTMENTS:
            return jsonify({
                "success": False,
                "message": f"Line-level access currently only applies to: {sorted(LINE_LEVEL_DEPARTMENTS)}.",
            }), 400
        if access_level == "SECTION" and department not in SECTION_LEVEL_DEPARTMENTS:
            return jsonify({
                "success": False,
                "message": f"Section-level access currently only applies to: {sorted(SECTION_LEVEL_DEPARTMENTS)}.",
            }), 400
        if access_level == "SECTION":
            if assigned_section not in PRODUCTION_SECTIONS:
                return jsonify({"success": False, "message": f"Invalid section. Must be one of: {sorted(PRODUCTION_SECTIONS)}"}), 400
        if access_level == "LINE" and not (assigned_line and assigned_shift):
            return jsonify({"success": False, "message": "assigned_line and assigned_shift are both required for Line-level access."}), 400

        try:
            with db.engine.begin() as conn:
                if conn.execute(sa_text(
                    "SELECT 1 FROM frontend.users WHERE username = :u LIMIT 1"
                ), {"u": username}).fetchone():
                    return jsonify({"success": False, "message": "Username is already taken."})

                conn.execute(sa_text(
                    "INSERT INTO frontend.users "
                    "(username, password_hash, first_name, last_name, roles, department, "
                    " access_level, assigned_line, assigned_shift, assigned_section) "
                    "VALUES (:username, :password_hash, :first_name, :last_name, :roles, :department, "
                    "        :access_level, :assigned_line, :assigned_shift, :assigned_section)"
                ), {
                    "username":         username,
                    "password_hash":    generate_password_hash(password),
                    "first_name":       first_name,
                    "last_name":        last_name,
                    "roles":            roles,
                    "department":       department,
                    "access_level":     access_level,
                    "assigned_line":    assigned_line,
                    "assigned_shift":   assigned_shift,
                    "assigned_section": assigned_section,
                })
        except IntegrityError as e:
            # e.g. DB-level CHECK constraint on `roles`/`department`/`access_level`/`assigned_section` rejects the value
            if "users_roles_check" in str(e.orig):
                return jsonify({
                    "success": False,
                    "message": f"Invalid role. Must be one of: {sorted(ROLES)}",
                }), 400
            if "users_department_check" in str(e.orig):
                return jsonify({
                    "success": False,
                    "message": f"Invalid department. Must be one of: {sorted(DEPARTMENTS)}",
                }), 400
            if "users_access_level_check" in str(e.orig):
                return jsonify({
                    "success": False,
                    "message": f"Invalid access level. Must be one of: {sorted(ACCESS_LEVELS)}",
                }), 400
            if "users_assigned_section_check" in str(e.orig):
                return jsonify({
                    "success": False,
                    "message": f"Invalid section. Must be one of: {sorted(PRODUCTION_SECTIONS)}",
                }), 400
            raise

        return jsonify({"success": True, "message": f"Account '{username}' created as {roles} ({department}, {access_level})."})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Server error: {str(e)}"}), 500


@auth_bp.route("/logout")
def logout():
    session.clear()

    response = redirect(url_for("auth.home"))

    # Expire the Flask session cookie
    response.delete_cookie("session")

    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"

    return response


@auth_bp.route("/api/me")
@login_required
def me():
    """Returns current user role/department/access-tier info for frontend permission checks."""
    role = session.get("role")
    department = session.get("department")
    first_name = session.get("first_name", "")
    last_name = session.get("last_name", "")
    access_level = session.get("access_level", DEFAULT_ACCESS_LEVEL)
    can_manage_employees = (
        str(access_level or "").strip().upper() in {"SECTION", "DEPARTMENT", "GLOBAL"}
        or role == "Admin"
    )
    return jsonify({
        "username":         session.get("username"),
        "first_name":       first_name,
        "last_name":        last_name,
        "full_name":        f"{first_name} {last_name}".strip(),
        "role":             role,
        "department":       department,
        "access_level":     access_level,
        "assigned_line":    session.get("assigned_line"),
        "assigned_shift":   session.get("assigned_shift"),
        "assigned_section": session.get("assigned_section"),
        "is_admin":         role == "Admin",
        # Lets the frontend show/hide the HR-final-approval UI without
        # duplicating the Admin/Administration check in JS. This is a
        # convenience flag only — the actual gate is server-side, via
        # hr_approval_required on the HR-stage routes.
        "is_hr_approver": is_hr_approver(role, department),
        "can_manage_employees": can_manage_employees,
        # Same convenience-flag pattern for the No Work feature — actual
        # gate is server-side via no_work_access_required.
        "can_declare_no_work": can_declare_no_work(role, department),
        # Same convenience-flag pattern for Bulk Delete — actual gate is
        # server-side via bulk_delete_required on
        # /api/employees/bulk-delete. Deliberately separate from
        # can_manage_employees (see can_bulk_delete()'s docstring): Levels
        # 2-4 get this even without full manage access; Level 1 (Line
        # Leader) never does.
        "can_bulk_delete": can_bulk_delete(role, access_level),
    })