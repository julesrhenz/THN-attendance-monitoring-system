from datetime import datetime, timedelta, timezone
from sqlalchemy import text as sa_text


def record_shift_change(conn, emp_id, old_shift, new_shift, full_name=None):
    if (old_shift or '').strip() == (new_shift or '').strip():
        return
    stamp = datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)
    conn.execute(sa_text("""INSERT INTO frontend.employee_movements
        (emp_id, full_name, field_name, old_value, new_value, detected_at)
        VALUES (:emp_id, :name, 'SHIFT', :old, :new, :stamp)"""),
        {"emp_id": emp_id, "name": full_name, "old": old_shift, "new": new_shift, "stamp": stamp})
    conn.execute(sa_text("""UPDATE backend.biometric_logs SET processed=FALSE
        WHERE emp_id=:emp_id AND punch_time >= :since"""),
        {"emp_id": emp_id, "since": stamp.replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(days=1)})
