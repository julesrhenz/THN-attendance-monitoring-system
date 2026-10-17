"""Compatibility entry point. Attendance is derived only by the processor."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import text as sa_text


def recalculate_statuses_for_changed_employees(conn, changed_employees, lookback_days=30, effective_at=None):
    if not changed_employees:
        return 0
    effective_at = effective_at or datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)
    conn.execute(sa_text("SELECT pg_advisory_xact_lock(:key)"), {"key": 4815162342})
    result = conn.execute(sa_text("""
        UPDATE backend.biometric_logs SET processed = FALSE
        WHERE emp_id = ANY(:ids) AND punch_time >= :since
    """), {"ids": sorted({str(e["emp_id"]) for e in changed_employees}),
           "since": effective_at.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)})
    return result.rowcount
