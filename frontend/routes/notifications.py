from flask import Blueprint, request, jsonify, session
from sqlalchemy import text as sa_text
import traceback

from routes.extensions import db
from routes.decorators import login_required

notifications_bp = Blueprint("notifications", __name__)

VALID_NOTIFICATION_TYPES = {"TIME_IN_APPROVED"}


def _current_session_username() -> str:
    """The raw login username (e.g. 'CCSTAFF'), NOT the display full
    name. This is what requested_by / recipientId already use elsewhere
    (see the time-in-request payloads), so notifications key off the
    same value rather than data.py's current_username() display-name
    helper.
    """
    return (session.get("username") or "").strip()


@notifications_bp.route("/api/notifications", methods=["GET"])
@login_required
def list_notifications():
    """
    ?recipientId=<username> (required)
    ?isRead=true|false (optional -- omit to return both read and unread)

    Returns { success, notifications: [...] }, most recent first, capped
    at 100 rows (this is a notification feed, not an export/report).
    """
    recipient_id = (request.args.get("recipientId") or "").strip()
    is_read_param = request.args.get("isRead")

    if not recipient_id:
        return jsonify({"success": False, "message": "recipientId is required"}), 400

    clauses = ["recipient_id = :recipient_id"]
    params = {"recipient_id": recipient_id}

    if is_read_param is not None:
        clauses.append("is_read = :is_read")
        params["is_read"] = is_read_param.strip().lower() == "true"

    where = " AND ".join(clauses)

    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sa_text(f"""
                SELECT id, recipient_id, type, title, body, request_id,
                       is_read, created_at
                FROM frontend.notifications
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT 100
            """), params).mappings().all()
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

    notifications = [{
        "id": r["id"],
        "recipientId": r["recipient_id"],
        "type": r["type"],
        "title": r["title"],
        "body": r["body"],
        "requestId": r["request_id"],
        "isRead": bool(r["is_read"]),
        "timestamp": r["created_at"].isoformat() if r["created_at"] else None,
    } for r in rows]

    return jsonify({"success": True, "notifications": notifications})


@notifications_bp.route("/api/notifications", methods=["POST"])
@login_required
def create_notification():
    """
    Body: { recipientId, type, title, body, requestId, isRead, timestamp }

    `timestamp` from the client is accepted but NOT trusted for storage --
    created_at is always set server-side (NOW()), same reasoning as
    current_username() in data.py: never trust a client-supplied value for
    an audit/ordering column. The client's timestamp is effectively
    ignored; the response returns the authoritative server timestamp.
    """
    payload = request.get_json(silent=True) or {}

    recipient_id = (payload.get("recipientId") or "").strip()
    notif_type = (payload.get("type") or "").strip()
    title = (payload.get("title") or "").strip()
    body = (payload.get("body") or "").strip()
    request_id = payload.get("requestId")
    is_read = bool(payload.get("isRead", False))

    if not recipient_id:
        return jsonify({"success": False, "message": "recipientId is required"}), 400
    if not title:
        return jsonify({"success": False, "message": "title is required"}), 400
    if notif_type and notif_type not in VALID_NOTIFICATION_TYPES:
        # Not fatal -- just means a new type showed up that render logic
        # on the frontend doesn't have an icon for yet. Log and continue.
        print(f"NOTIFICATIONS: unrecognized type '{notif_type}' — storing anyway")

    try:
        with db.engine.begin() as conn:
            row = conn.execute(sa_text("""
                INSERT INTO frontend.notifications
                    (recipient_id, type, title, body, request_id, is_read, created_at)
                VALUES (:recipient_id, :type, :title, :body, :request_id, :is_read, NOW())
                RETURNING id, created_at
            """), {
                "recipient_id": recipient_id,
                "type": notif_type or None,
                "title": title,
                "body": body or None,
                "request_id": request_id,
                "is_read": is_read,
            }).fetchone()
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

    return jsonify({
        "success": True,
        "id": row[0],
        "timestamp": row[1].isoformat() if row[1] else None,
    })


@notifications_bp.route("/api/notifications/<int:notification_id>/read", methods=["PUT"])
@login_required
def mark_notification_read(notification_id: int):
    try:
        with db.engine.begin() as conn:
            result = conn.execute(sa_text("""
                UPDATE frontend.notifications
                SET is_read = TRUE
                WHERE id = :id
            """), {"id": notification_id})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

    if result.rowcount == 0:
        return jsonify({"success": False, "message": "Notification not found."}), 404

    return jsonify({"success": True})