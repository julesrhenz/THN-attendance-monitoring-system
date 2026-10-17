"""
user_management_routes.py

Server side of the User Management module (page + /api/users).

Wire it up once, wherever the app is created:

    from user_management_routes import user_management_bp
    app.register_blueprint(user_management_bp)

What is finished here:
  * the access guard        (is_user_manager / the two decorators)
  * request validation      (validate_new_user -- same rules the old public
                             register form enforced in the browser)
  * the four routes

What YOU still connect (search for "CONNECT ME"):
  * list_accounts(), create_account(), update_account(), delete_account()
    These four touch your user table / password hashing, which I can't see.
    Reuse whatever /register in auth.py already does to hash the password and
    insert the row -- but WITHOUT the "log the new user in" step, otherwise the
    admin's own session gets replaced by the account they just created.

    NOTE ON EDITING: passwords are hashed, so there is no way to display an
    account's *current* password back to the admin. The Edit dialog therefore
    only lets the admin set a NEW password (optional -- blank keeps the old
    one); update_account() is where that new password gets hashed in, same as
    create_account() does for a brand-new account.
"""

from functools import wraps

from flask import Blueprint, jsonify, redirect, render_template, request, session
from werkzeug.security import generate_password_hash
from sqlalchemy import text as sa_text
from sqlalchemy.exc import IntegrityError

from routes.extensions import db

user_management_bp = Blueprint("user_management", __name__)

# Columns returned to the page for every account. No password/hash, ever.
_ACCOUNT_COLUMNS = (
    "username, first_name, last_name, roles, department, "
    "access_level, assigned_line, assigned_shift, assigned_section"
)


def _is_last_global_admin(conn, username):
    """True if `username` is currently the only GLOBAL/ADMINISTRATION admin."""
    row = conn.execute(sa_text(
        "SELECT username FROM frontend.users "
        "WHERE roles = 'Admin' AND department = 'ADMINISTRATION' AND access_level = 'GLOBAL'"
    )).fetchall()
    admins = {r.username for r in row}
    return admins == {username}


# ---------------------------------------------------------------------------
# Access guard
# ---------------------------------------------------------------------------
# Same rule as /api/me + isUserManager() in sidebar.js:
#   role Admin  +  access_level GLOBAL  +  department ADMINISTRATION
# (is_admin in /api/me is derived from role == "Admin".)
#
# ASSUMPTION: the login code stores these session keys: "username", "role",
# "access_level", "department" -- the sidebar template already reads
# session["role"] and session["access_level"]. If "department" is stored under
# another name, change it below. Best option: build this from the same helper
# that produces /api/me so the two can never drift apart.

def _current_user_is_logged_in():
    return bool(session.get("username"))


def is_user_manager():
    return (
        session.get("role") == "Admin"
        and str(session.get("access_level", "")).strip().upper() == "GLOBAL"
        and str(session.get("department", "")).strip().upper() == "ADMINISTRATION"
    )


def user_manager_required_page(view):
    """For the HTML page: send people somewhere sensible instead of a JSON error."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not _current_user_is_logged_in():
            return redirect("/")
        if not is_user_manager():
            return redirect("/maindashboard")
        return view(*args, **kwargs)
    return wrapper


def user_manager_required_api(view):
    """For /api/users*: JSON 401 / 403 that user_management.js already understands."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not _current_user_is_logged_in():
            return jsonify(success=False, message="Please sign in again."), 401
        if not is_user_manager():
            return jsonify(success=False, message="You don't have permission to manage users."), 403
        return view(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# Validation (mirrors the rules in user_management.js / the old register form)
# ---------------------------------------------------------------------------
VALID_ROLES = {"Admin", "Supervisor", "Viewer"}
VALID_DEPARTMENTS = {"PRODUCTION", "TECHNICAL", "QUALITY", "ADMINISTRATION"}
LINE_LEVEL_DEPARTMENTS = {"PRODUCTION", "QUALITY"}
SECTION_LEVEL_DEPARTMENTS = {"PRODUCTION"}
VALID_SECTIONS = {"ASSEMBLY", "WH", "CC"}
VALID_SHIFTS = {"Day Shift", "Night Shift", "Both Shifts"}
MIN_PASSWORD_LENGTH = 6
# Must match DEFAULT_PASSWORD in user_management.js. Deliberately shorter than
# MIN_PASSWORD_LENGTH: the bulk reset sets a temporary default, so the
# minimum-length rule for user-chosen passwords is NOT applied to it.
DEFAULT_RESET_PASSWORD = "0000"


def allowed_access_levels(department, role):
    if department == "ADMINISTRATION":
        return {"GLOBAL"}
    levels = {"DEPARTMENT"}
    if department in LINE_LEVEL_DEPARTMENTS:
        levels.add("LINE")
    if department in SECTION_LEVEL_DEPARTMENTS:
        levels.add("SECTION")
    if role == "Admin":
        levels.add("GLOBAL")
    return levels


def validate_new_user(data):
    """Return a cleaned dict, or raise ValueError with a message safe to show the admin."""
    data = data or {}
    first_name = str(data.get("first_name") or "").strip()
    last_name = str(data.get("last_name") or "").strip()
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")
    # the browser posts "roles" (same as /register); accept "role" too
    role = str(data.get("roles") or data.get("role") or "").strip()
    department = str(data.get("department") or "").strip().upper()
    access_level = str(data.get("access_level") or "").strip().upper()
    line = (data.get("assigned_line") or None)
    shift = (data.get("assigned_shift") or None)
    section = (data.get("assigned_section") or None)

    if not (first_name and last_name and username and password and department and access_level):
        raise ValueError("Fill in all required fields, including department and access level.")
    if role not in VALID_ROLES:
        raise ValueError("Choose a valid role.")
    if department not in VALID_DEPARTMENTS:
        raise ValueError("Choose a valid department.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if access_level not in allowed_access_levels(department, role):
        raise ValueError("That access level isn't allowed for this department and role.")

    if access_level == "LINE":
        line = str(line or "").strip()
        if not line or shift not in VALID_SHIFTS:
            raise ValueError("Choose both a line and a shift for Line-level access.")
        section = None
    elif access_level == "SECTION":
        section = str(section or "").strip().upper()
        if section not in VALID_SECTIONS:
            raise ValueError("Choose a section for Section-level access.")
        line = shift = None
    else:
        line = shift = section = None

    return {
        "first_name": first_name,
        "last_name": last_name,
        "username": username,
        "password": password,          # hash it inside create_account(), never store as-is
        "role": role,
        "department": department,
        "access_level": access_level,
        "assigned_line": line,
        "assigned_shift": shift,
        "assigned_section": section,
    }


def validate_edit_user(data):
    """Same shape as validate_new_user(), but for editing an existing account:
    the password is OPTIONAL here. An empty/omitted password means "leave the
    account's current password alone" -- update_account() must treat
    clean["password"] is None as "don't touch the hash".
    """
    data = data or {}
    first_name = str(data.get("first_name") or "").strip()
    last_name = str(data.get("last_name") or "").strip()
    username = str(data.get("username") or "").strip()
    password = data.get("password")
    password = str(password).strip() if password else ""   # "" == unchanged
    role = str(data.get("roles") or data.get("role") or "").strip()
    department = str(data.get("department") or "").strip().upper()
    access_level = str(data.get("access_level") or "").strip().upper()
    line = (data.get("assigned_line") or None)
    shift = (data.get("assigned_shift") or None)
    section = (data.get("assigned_section") or None)

    if not (first_name and last_name and username and department and access_level):
        raise ValueError("Fill in all required fields, including department and access level.")
    if role not in VALID_ROLES:
        raise ValueError("Choose a valid role.")
    if department not in VALID_DEPARTMENTS:
        raise ValueError("Choose a valid department.")
    if password and len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if access_level not in allowed_access_levels(department, role):
        raise ValueError("That access level isn't allowed for this department and role.")

    if access_level == "LINE":
        line = str(line or "").strip()
        if not line or shift not in VALID_SHIFTS:
            raise ValueError("Choose both a line and a shift for Line-level access.")
        section = None
    elif access_level == "SECTION":
        section = str(section or "").strip().upper()
        if section not in VALID_SECTIONS:
            raise ValueError("Choose a section for Section-level access.")
        line = shift = None
    else:
        line = shift = section = None

    return {
        "first_name": first_name,
        "last_name": last_name,
        "username": username,
        "password": password or None,  # None -> leave the existing password alone
        "role": role,
        "department": department,
        "access_level": access_level,
        "assigned_line": line,
        "assigned_shift": shift,
        "assigned_section": section,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@user_management_bp.route("/user_management")
@user_manager_required_page
def user_management_page():
    return render_template("user_management.html")


@user_management_bp.route("/api/users", methods=["GET"])
@user_manager_required_api
def api_list_users():
    return jsonify(users=list_accounts())


@user_management_bp.route("/api/users", methods=["POST"])
@user_manager_required_api
def api_create_user():
    try:
        clean = validate_new_user(request.get_json(silent=True))
        create_account(clean)
    except ValueError as exc:                       # validation / duplicate username
        return jsonify(success=False, message=str(exc)), 400
    return jsonify(success=True, message="Account created."), 201


@user_management_bp.route("/api/users/<user_id>", methods=["PUT"])
@user_manager_required_api
def api_update_user(user_id):
    try:
        clean = validate_edit_user(request.get_json(silent=True))
        update_account(user_id, clean, acting_username=session.get("username"))
    except LookupError:
        return jsonify(success=False, message="That account no longer exists."), 404
    except ValueError as exc:                       # validation / duplicate username / last admin
        return jsonify(success=False, message=str(exc)), 400
    return jsonify(success=True, message="Account updated.")


@user_management_bp.route("/api/users/<user_id>", methods=["DELETE"])
@user_manager_required_api
def api_delete_user(user_id):
    try:
        delete_account(user_id, acting_username=session.get("username"))
    except LookupError:
        return jsonify(success=False, message="That account no longer exists."), 404
    except ValueError as exc:                       # e.g. deleting yourself / last global admin
        return jsonify(success=False, message=str(exc)), 400
    return jsonify(success=True, message="Account deleted.")


@user_management_bp.route("/api/users/<user_id>/password", methods=["PUT"])
@user_manager_required_api
def api_reset_password(user_id):
    """Password-only reset. Called once per selected account by the bulk
    "Reset password to 0000" button in user_management.js."""
    data = request.get_json(silent=True) or {}
    try:
        reset_password(
            user_id,
            data.get("password") or DEFAULT_RESET_PASSWORD,
            acting_username=session.get("username"),
        )
    except LookupError:
        return jsonify(success=False, message="That account no longer exists."), 404
    except ValueError as exc:
        return jsonify(success=False, message=str(exc)), 400
    return jsonify(success=True, message="Password reset.")


# ---------------------------------------------------------------------------
# CONNECT ME -- data access. Replace the bodies with your real DB code.
# ---------------------------------------------------------------------------
def list_accounts():
    """
    Return a list of dicts, one per account, with these keys:
        id, username, first_name, last_name, full_name, role, department,
        access_level, assigned_line, assigned_shift, assigned_section
    NEVER include the password hash.
    """
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text(
            f"SELECT {_ACCOUNT_COLUMNS} FROM frontend.users ORDER BY username"
        )).fetchall()

    return [
        {
            # No surrogate id column on frontend.users -- the page falls back
            # to username as the row key (see keyOf() in user_management.js).
            "username": r.username,
            "first_name": r.first_name,
            "last_name": r.last_name,
            "full_name": f"{r.first_name} {r.last_name}".strip(),
            "role": r.roles,
            "department": r.department,
            "access_level": r.access_level,
            "assigned_line": r.assigned_line,
            "assigned_shift": r.assigned_shift,
            "assigned_section": r.assigned_section,
        }
        for r in rows
    ]


def create_account(clean):
    """
    `clean` comes from validate_new_user(). Must:
      * raise ValueError("Username already exists.") if the username is taken
        (compare case-insensitively),
      * hash clean["password"] the same way /register does,
      * insert the row,
      * NOT touch the Flask session (no auto-login).
    """
    try:
        with db.engine.begin() as conn:
            if conn.execute(sa_text(
                "SELECT 1 FROM frontend.users WHERE lower(username) = lower(:u) LIMIT 1"
            ), {"u": clean["username"]}).fetchone():
                raise ValueError("Username already exists.")

            conn.execute(sa_text(
                "INSERT INTO frontend.users "
                "(username, password_hash, first_name, last_name, roles, department, "
                " access_level, assigned_line, assigned_shift, assigned_section) "
                "VALUES (:username, :password_hash, :first_name, :last_name, :roles, :department, "
                "        :access_level, :assigned_line, :assigned_shift, :assigned_section)"
            ), {
                "username": clean["username"],
                "password_hash": generate_password_hash(clean["password"]),
                "first_name": clean["first_name"],
                "last_name": clean["last_name"],
                "roles": clean["role"],
                "department": clean["department"],
                "access_level": clean["access_level"],
                "assigned_line": clean["assigned_line"],
                "assigned_shift": clean["assigned_shift"],
                "assigned_section": clean["assigned_section"],
            })
    except IntegrityError as e:
        # DB-level CHECK constraints (users_roles_check / _department_check /
        # _access_level_check / _assigned_section_check) as a last line of
        # defense -- validate_new_user() should already block these.
        raise ValueError("That combination of role/department/access level/section isn't allowed.") from e


def update_account(user_id, clean, acting_username):
    """
    `clean` comes from validate_edit_user(). Must:
      * raise LookupError if no such account,
      * raise ValueError("Username already exists.") if clean["username"] is
        taken by a DIFFERENT account (compare case-insensitively; renaming an
        account to the username it already has is fine),
      * if clean["password"] is not None, hash it the same way /register does
        and overwrite the stored hash; if it IS None, leave the existing hash
        untouched -- there is no way to recover/show the old plaintext, so the
        page only ever lets the admin set a new one, never view the old one,
      * raise ValueError("At least one global administrator must remain.") if
        this edit would take away the last remaining GLOBAL / ADMINISTRATION
        admin (e.g. changing that person's role away from Admin, or their
        department/access_level away from ADMINISTRATION/GLOBAL),
      * update the row's other fields (first/last name, role, department,
        access_level, assigned_line/shift/section),
      * NOT touch the Flask session (an admin editing someone else's account,
        or even their own, should not change who is currently logged in).
    `user_id` arrives as a string; the page sends the account's `id`
    (or its username if your list_accounts() has no `id`).
    """
    try:
        with db.engine.begin() as conn:
            current = conn.execute(sa_text(
                "SELECT username, roles, department, access_level "
                "FROM frontend.users WHERE username = :u LIMIT 1"
            ), {"u": user_id}).fetchone()
            if not current:
                raise LookupError()

            if current.username.lower() != clean["username"].lower():
                clash = conn.execute(sa_text(
                    "SELECT 1 FROM frontend.users WHERE lower(username) = lower(:u) LIMIT 1"
                ), {"u": clean["username"]}).fetchone()
                if clash:
                    raise ValueError("Username already exists.")

            was_global_admin = (
                current.roles == "Admin"
                and current.department == "ADMINISTRATION"
                and current.access_level == "GLOBAL"
            )
            will_be_global_admin = (
                clean["role"] == "Admin"
                and clean["department"] == "ADMINISTRATION"
                and clean["access_level"] == "GLOBAL"
            )
            if was_global_admin and not will_be_global_admin:
                if _is_last_global_admin(conn, current.username):
                    raise ValueError("At least one global administrator must remain.")

            params = {
                "old_username": current.username,
                "username": clean["username"],
                "first_name": clean["first_name"],
                "last_name": clean["last_name"],
                "roles": clean["role"],
                "department": clean["department"],
                "access_level": clean["access_level"],
                "assigned_line": clean["assigned_line"],
                "assigned_shift": clean["assigned_shift"],
                "assigned_section": clean["assigned_section"],
            }
            set_clause = (
                "username = :username, first_name = :first_name, last_name = :last_name, "
                "roles = :roles, department = :department, access_level = :access_level, "
                "assigned_line = :assigned_line, assigned_shift = :assigned_shift, "
                "assigned_section = :assigned_section"
            )
            if clean["password"] is not None:
                set_clause += ", password_hash = :password_hash"
                params["password_hash"] = generate_password_hash(clean["password"])

            conn.execute(sa_text(
                f"UPDATE frontend.users SET {set_clause} WHERE username = :old_username"
            ), params)
    except IntegrityError as e:
        raise ValueError("That combination of role/department/access level/section isn't allowed.") from e


def delete_account(user_id, acting_username):
    """
    Must:
      * raise LookupError if no such account,
      * raise ValueError("You can't delete your own account.") if the target
        is `acting_username`,
      * raise ValueError("At least one global administrator must remain.") if
        this is the last GLOBAL / ADMINISTRATION admin,
      * delete the row.
    `user_id` arrives as a string; the page sends the account's `id`
    (or its username if your list_accounts() has no `id`).
    """
    with db.engine.begin() as conn:
        row = conn.execute(sa_text(
            "SELECT username, roles, department, access_level "
            "FROM frontend.users WHERE username = :u LIMIT 1"
        ), {"u": user_id}).fetchone()
        if not row:
            raise LookupError()

        if row.username.lower() == (acting_username or "").lower():
            raise ValueError("You can't delete your own account.")

        is_global_admin = (
            row.roles == "Admin"
            and row.department == "ADMINISTRATION"
            and row.access_level == "GLOBAL"
        )
        if is_global_admin and _is_last_global_admin(conn, row.username):
            raise ValueError("At least one global administrator must remain.")

        conn.execute(sa_text(
            "DELETE FROM frontend.users WHERE username = :u"
        ), {"u": row.username})


def reset_password(user_id, new_password, acting_username):
    """
    Overwrite ONLY the password hash. Department / role / access level are
    never touched. Must:
      * raise LookupError if no such account,
      * raise ValueError if the target is `acting_username` (the page already
        blocks this in the UI; enforced here too since UI checks are bypassable).
    """
    new_password = str(new_password or "").strip()
    if not new_password:
        raise ValueError("Password can't be empty.")

    with db.engine.begin() as conn:
        row = conn.execute(sa_text(
            "SELECT username FROM frontend.users WHERE username = :u LIMIT 1"
        ), {"u": user_id}).fetchone()
        if not row:
            raise LookupError()

        if row.username.lower() == (acting_username or "").lower():
            raise ValueError("You can't reset your own password here.")

        conn.execute(sa_text(
            "UPDATE frontend.users SET password_hash = :h WHERE username = :u"
        ), {"h": generate_password_hash(new_password), "u": row.username})