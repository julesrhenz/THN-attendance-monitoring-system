from flask import session, redirect, url_for, request, jsonify
from functools import wraps


def login_required(f):
    """Block unauthenticated users."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.home"))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """
    Block non-Admin users from write/action endpoints.
    - API routes  → 403 JSON
    - Page routes → redirect to dashboard
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.home"))
        if session.get("role") != "Admin":
            if request.path.startswith("/api/") or request.is_json:
                return jsonify({
                    "success": False,
                    "message": "Access denied. Admin role required.",
                }), 403
            return redirect(url_for("auth.dashboard"))
        return f(*args, **kwargs)
    return decorated
def roles_required(*allowed_roles):
    """
    Block users whose role isn't in allowed_roles from write/action endpoints.
    - API routes  → 403 JSON
    - Page routes → redirect to dashboard
    """
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if not session.get("logged_in"):
                return redirect(url_for("auth.home"))
            if session.get("role") not in allowed_roles:
                if request.path.startswith("/api/") or request.is_json:
                    return jsonify({
                        "success": False,
                        "message": f"Access denied. Requires one of: {', '.join(allowed_roles)}.",
                    }), 403
                return redirect(url_for("auth.dashboard"))
            return f(*args, **kwargs)
        return decorated
    return decorator


def _api_forbidden(message: str):
    """Return the standard API/page denial response used by tier guards."""
    if request.path.startswith("/api/") or request.is_json:
        return jsonify({"success": False, "message": message}), 403
    return redirect(url_for("auth.dashboard"))


def line_leader_required(f):
    """Allow only Level 1 (LINE) accounts to create attendance change requests.

    This is deliberately based on access_level, not the display role name:
    a Line Leader may be stored as Supervisor or Viewer in legacy user data.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return _api_forbidden("Login required.")
        if (session.get("access_level") or "").strip().upper() != "LINE":
            return _api_forbidden("Only Level 1 Line Leaders can submit attendance change requests.")
        return f(*args, **kwargs)
    return decorated


def level_2_to_4_required(f):
    """Allow administrative actions for SECTION, DEPARTMENT, and GLOBAL users.

    Level 1 (LINE) is always denied, including direct API calls.  Admin users
    without a migrated access_level retain access as a safe legacy fallback.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return _api_forbidden("Login required.")
        level = (session.get("access_level") or "").strip().upper()
        if level not in {"SECTION", "DEPARTMENT", "GLOBAL"} and session.get("role") != "Admin":
            return _api_forbidden("Level 2, Level 3, or Level 4 access is required.")
        return f(*args, **kwargs)
    return decorated
