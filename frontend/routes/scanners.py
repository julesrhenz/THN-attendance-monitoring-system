"""Admin API for the scanner inventory used by the attendance sync worker."""
from __future__ import annotations

import hmac
import ipaddress
from threading import Lock

from flask import Blueprint, jsonify, request
from sqlalchemy import text as sa_text
from sqlalchemy.exc import IntegrityError

from routes.decorators import admin_required
from routes.extensions import db


scanners_bp = Blueprint("scanners", __name__)
_SCANNER_TYPES = {"zkteco": "ZKTeco", "anviz": "Anviz"}
_schema_lock = Lock()
_schema_ready = False

# ── Scanner-management access gate ──────────────────────────────────────────
# On top of the normal @admin_required role check, this tab requires a
# second, separate passcode. Originally this was tracked in the Flask
# session (cookie-based) but that made it vulnerable to a race with
# sidebar.js's 30s polling loop: EVERY response re-signs and re-sends the
# whole session as Set-Cookie by default, so a stale poll response landing
# just after a real unlock could silently overwrite/roll it back.
#
# This version is deliberately stateless instead: the frontend sends the
# password as a header on every scanner-management request, checked
# directly against this constant. Nothing is stored server-side, so
# there's no session/cookie state left to race.
#
# To change the password: edit the string below and restart the app
# (`python app.py`) -- no env var, no config file.
SCANNER_ACCESS_PASSWORD = "edward"
SCANNER_ACCESS_HEADER = "X-Scanner-Access-Password"


def scanner_access_required(view):
    """Gate a route behind the scanner-management passcode header.

    Always stack this UNDER @admin_required (i.e. @admin_required listed
    first) so role is still checked even if this header check is ever
    bypassed.
    """
    from functools import wraps

    @wraps(view)
    def wrapped(*args, **kwargs):
        submitted = request.headers.get(SCANNER_ACCESS_HEADER, "")
        if not hmac.compare_digest(submitted, SCANNER_ACCESS_PASSWORD):
            return jsonify({
                "success": False,
                "locked": True,
                "message": "Scanner access is locked. Enter the access password to continue.",
            }), 403
        return view(*args, **kwargs)
    return wrapped


def _ensure_scanner_columns() -> None:
    """Make the scanner-management additions safe for older deployments.

    Some live databases predate `port` and `is_enabled`; without this small
    forward migration the page itself cannot load or add a scanner. It runs
    once per web-process, under a lock, so ordinary dashboard requests do not
    repeatedly issue DDL.
    """
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        with db.engine.begin() as conn:
            conn.execute(sa_text("ALTER TABLE backend.scanners ADD COLUMN IF NOT EXISTS port INTEGER"))
            conn.execute(sa_text("ALTER TABLE backend.scanners ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE"))
        _schema_ready = True


def _validate_payload(payload: dict, *, partial: bool = False) -> tuple[dict, str | None]:
    """Validate user input before it becomes a worker connection target."""
    clean: dict = {}

    if "ip_address" in payload or not partial:
        raw_ip = str(payload.get("ip_address") or "").strip()
        try:
            clean["ip_address"] = str(ipaddress.ip_address(raw_ip))
        except ValueError:
            return {}, "ip_address must be a valid IPv4 or IPv6 address."

    if "scanner_type" in payload or not partial:
        scanner_type = str(payload.get("scanner_type") or "").strip().lower()
        if scanner_type not in _SCANNER_TYPES:
            return {}, "scanner_type must be ZKTeco or Anviz."
        clean["scanner_type"] = _SCANNER_TYPES[scanner_type]

    if "port" in payload:
        raw_port = payload.get("port")
        if raw_port in (None, ""):
            clean["port"] = None
        else:
            try:
                port = int(raw_port)
            except (TypeError, ValueError):
                return {}, "port must be a number from 1 to 65535."
            if not 1 <= port <= 65535:
                return {}, "port must be a number from 1 to 65535."
            clean["port"] = port

    if "location" in payload:
        location = str(payload.get("location") or "").strip()
        if len(location) > 100:
            return {}, "location must be at most 100 characters."
        clean["location"] = location or None

    if "is_enabled" in payload:
        value = payload["is_enabled"]
        if not isinstance(value, bool):
            return {}, "is_enabled must be true or false."
        clean["is_enabled"] = value

    return clean, None


def _resolve_agency(conn, payload: dict) -> int | None:
    """Resolve either an agency id or its configured code/name to `emp`."""
    agency_id = payload.get("agency_id")
    if agency_id not in (None, ""):
        try:
            agency_id = int(agency_id)
        except (TypeError, ValueError):
            return None
        return conn.execute(sa_text("SELECT emp FROM backend.agencies WHERE emp = :emp"), {"emp": agency_id}).scalar()

    agency = str(payload.get("agency") or "").strip()
    if not agency:
        return None
    return conn.execute(sa_text("""
        SELECT emp FROM backend.agencies a
        WHERE LOWER(COALESCE(to_jsonb(a)->>'emp_name', to_jsonb(a)->>'agency_code', '')) = LOWER(:agency)
    """), {"agency": agency}).scalar()


def _sync_scanner_id_sequence(conn) -> None:
    """Advance the SERIAL sequence after historic/manual ID inserts.

    The existing table already contains IDs 1–14, but its PostgreSQL sequence
    can still be at 1 when those rows were imported manually. In that state
    an insert with a brand-new IP fails on the *primary key*, not the IP. This
    aligns the sequence with the current highest stored ID before new rows are
    inserted, leaving PostgreSQL to allocate the actual ID safely.
    """
    conn.execute(sa_text("""
        SELECT setval(
            pg_get_serial_sequence('backend.scanners', 'scanner_id'),
            COALESCE(MAX(scanner_id), 1),
            COUNT(*) > 0
        )
        FROM backend.scanners
    """))


def _integrity_error_message(error: IntegrityError) -> str:
    constraint = getattr(getattr(error, "orig", None), "diag", None)
    constraint_name = getattr(constraint, "constraint_name", "") or ""
    if "ip_address" in constraint_name:
        return "That IP address is already assigned to a scanner."
    if "pkey" in constraint_name or "scanner_id" in constraint_name:
        return "The scanner ID sequence was out of date. Please submit the scanner again."
    if "emp" in constraint_name or "agency" in constraint_name:
        return "The selected agency is not available in the scanner database."
    return "The scanner could not be saved because of a database constraint."


@scanners_bp.route("/api/scanner-access/verify", methods=["POST"])
@admin_required
def scanner_access_verify():
    """
    Checks a submitted password against the hardcoded constant. Stateless --
    doesn't set anything server-side. On success, the frontend remembers the
    password itself (in sessionStorage) and resends it as a header on every
    subsequent scanner-management request; this endpoint just gives the
    modal a clean 200/401 to react to before the user does anything else.
    """
    payload = request.get_json(silent=True) or {}
    submitted = str(payload.get("password") or "")
    if not hmac.compare_digest(submitted, SCANNER_ACCESS_PASSWORD):
        return jsonify({"success": False, "message": "Incorrect password."}), 401
    return jsonify({"success": True})


@scanners_bp.route("/api/scanners", methods=["GET"])
@admin_required
@scanner_access_required
def list_scanners():
    _ensure_scanner_columns()
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT s.scanner_id, s.emp AS agency_id,
                   COALESCE(to_jsonb(a)->>'emp_name', to_jsonb(a)->>'agency_code', 'Agency ' || s.emp::text) AS agency,
                   s.ip_address, s.port, s.scanner_type, s.location,
                   s.is_enabled, s.created_at
            FROM backend.scanners s
            LEFT JOIN backend.agencies a ON a.emp = s.emp
            ORDER BY s.scanner_id
        """)).mappings().all()
        next_scanner_id = conn.execute(sa_text("""
            SELECT COALESCE(MAX(scanner_id), 0) + 1
            FROM backend.scanners
        """)).scalar_one()
    return jsonify({
        "success": True,
        "next_scanner_id": next_scanner_id,
        "scanners": [dict(row) for row in rows],
    })


@scanners_bp.route("/api/scanner-agencies", methods=["GET"])
@admin_required
@scanner_access_required
def list_scanner_agencies():
    with db.engine.connect() as conn:
        rows = conn.execute(sa_text("""
            SELECT a.emp AS agency_id,
                   COALESCE(to_jsonb(a)->>'emp_name', to_jsonb(a)->>'agency_code', 'Agency ' || a.emp::text) AS agency
            FROM backend.agencies a
            ORDER BY agency
        """)).mappings().all()
    return jsonify({"success": True, "agencies": [dict(row) for row in rows]})


@scanners_bp.route("/api/scanners", methods=["POST"])
@admin_required
@scanner_access_required
def create_scanner():
    _ensure_scanner_columns()
    payload = request.get_json(silent=True) or {}
    clean, error = _validate_payload(payload)
    if error:
        return jsonify({"success": False, "message": error}), 400

    try:
        with db.engine.begin() as conn:
            agency_id = _resolve_agency(conn, payload)
            if agency_id is None:
                return jsonify({"success": False, "message": "Provide an existing agency_id or agency."}), 400
            _sync_scanner_id_sequence(conn)
            scanner_id = conn.execute(sa_text("""
                INSERT INTO backend.scanners (emp, ip_address, port, scanner_type, location, is_enabled)
                VALUES (:agency_id, :ip_address, :port, :scanner_type, :location, :is_enabled)
                RETURNING scanner_id
            """), {
                "agency_id": agency_id,
                "port": clean.get("port"),
                "location": clean.get("location"),
                "is_enabled": clean.get("is_enabled", True),
                **clean,
            }).scalar_one()
    except IntegrityError as error:
        return jsonify({"success": False, "message": _integrity_error_message(error)}), 409
    return jsonify({"success": True, "scanner_id": scanner_id}), 201


@scanners_bp.route("/api/scanners/<int:scanner_id>", methods=["PUT"])
@admin_required
@scanner_access_required
def update_scanner(scanner_id: int):
    _ensure_scanner_columns()
    payload = request.get_json(silent=True) or {}
    clean, error = _validate_payload(payload, partial=True)
    if error:
        return jsonify({"success": False, "message": error}), 400

    try:
        with db.engine.begin() as conn:
            if "agency_id" in payload or "agency" in payload:
                agency_id = _resolve_agency(conn, payload)
                if agency_id is None:
                    return jsonify({"success": False, "message": "Provide an existing agency_id or agency."}), 400
                clean["emp"] = agency_id
            if not clean:
                return jsonify({"success": False, "message": "No scanner fields were provided."}), 400

            assignments = ", ".join(f"{column} = :{column}" for column in clean)
            result = conn.execute(sa_text(f"""
                UPDATE backend.scanners
                SET {assignments}
                WHERE scanner_id = :scanner_id
            """), {**clean, "scanner_id": scanner_id})
    except IntegrityError as error:
        return jsonify({"success": False, "message": _integrity_error_message(error)}), 409
    if result.rowcount == 0:
        return jsonify({"success": False, "message": "Scanner not found."}), 404
    return jsonify({"success": True, "scanner_id": scanner_id})


@scanners_bp.route("/api/scanners/<int:scanner_id>", methods=["DELETE"])
@admin_required
@scanner_access_required
def delete_scanner(scanner_id: int):
    """Delete only unused scanners; preserve scanner IDs in punch history."""
    _ensure_scanner_columns()
    with db.engine.begin() as conn:
        exists = conn.execute(sa_text("""
            SELECT EXISTS(
                SELECT 1 FROM backend.biometric_logs WHERE scanner_id = :scanner_id
            )
        """), {"scanner_id": scanner_id}).scalar_one()
        if exists:
            return jsonify({
                "success": False,
                "message": "This scanner has biometric logs and cannot be deleted. Disable it instead to preserve attendance history.",
            }), 409
        result = conn.execute(sa_text("""
            DELETE FROM backend.scanners WHERE scanner_id = :scanner_id
        """), {"scanner_id": scanner_id})
    if result.rowcount == 0:
        return jsonify({"success": False, "message": "Scanner not found."}), 404
    return jsonify({"success": True, "scanner_id": scanner_id})