"""Record a reviewed schedule/punch correction. Preview by default; --apply saves."""
import argparse
from datetime import datetime, timedelta
from attendance.attendance_processor import (
    get_db_connection, ensure_matching_schema, ensure_attendance_columns,
    _PROCESS_ATTENDANCE_LOCK, process_attendance,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--employee', required=True)
    parser.add_argument('--punch', required=True, help='Plant-local YYYY-MM-DD HH:MM:SS')
    parser.add_argument('--date', required=True, help='Attendance date YYYY-MM-DD')
    parser.add_argument('--shift', required=True)
    parser.add_argument('--role', choices=['IN', 'OUT'], required=True)
    parser.add_argument('--confirmed-by', required=True)
    parser.add_argument('--reason', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    punch = datetime.strptime(args.punch, '%Y-%m-%d %H:%M:%S')
    work_date = datetime.strptime(args.date, '%Y-%m-%d').date()
    if abs((punch.date() - work_date).days) > 1:
        parser.error('Punch must be within one calendar day of the attendance date.')
    if not args.reason.strip() or not args.confirmed_by.strip():
        parser.error('Reason and confirmer must be nonempty.')
    print(f'{args.employee}: {punch} -> {work_date}, {args.shift}, {args.role}')
    print('Also confirms the shift for this employee on this attendance date only.')
    if not args.apply:
        print('Preview only. Add --apply to save and reprocess. No database connection was opened.')
        return
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute('SELECT pg_advisory_xact_lock(%s)', (_PROCESS_ATTENDANCE_LOCK,))
        ensure_matching_schema(cur)
        ensure_attendance_columns(cur)
        cur.execute('SELECT shift_name FROM shifts WHERE lower(trim(shift_name)) = lower(trim(%s))', (args.shift,))
        shifts = cur.fetchall()
        if len(shifts) != 1:
            raise ValueError('Shift must match exactly one configured shift.')
        shift = shifts[0][0]
        cur.execute('SELECT id FROM biometric_logs WHERE emp_id = %s AND punch_time = %s', (args.employee, punch))
        if not cur.fetchall():
            raise ValueError('Exact raw punch not found for this employee; no correction saved.')
        start = min(work_date, punch.date()) - timedelta(days=1)
        end = max(work_date, punch.date()) + timedelta(days=1)
        cur.execute('SELECT attendance_date FROM attendance_logs WHERE emp_id = %s AND attendance_date BETWEEN %s AND %s AND manual_override = TRUE', (args.employee, start, end))
        if cur.fetchall():
            raise ValueError('Neighboring attendance has manual_override=TRUE. Reconcile those approved records first; no correction saved.')
        cur.execute('SELECT work_date, shift_name, role FROM frontend.attendance_punch_assignments WHERE emp_id = %s AND punch_time = %s', (args.employee, punch))
        existing = cur.fetchone()
        if existing and existing != (work_date, shift, args.role):
            raise ValueError('This punch already has a different confirmation; no changes saved.')
        cur.execute('SELECT shift_name FROM frontend.attendance_schedule_corrections WHERE emp_id = %s AND work_date = %s', (args.employee, work_date))
        existing = cur.fetchone()
        if existing and existing[0] != shift:
            raise ValueError('This date already has a different confirmed shift; no changes saved.')
        cur.execute('''INSERT INTO frontend.attendance_schedule_corrections
            (emp_id, work_date, shift_name, reason, confirmed_by) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (emp_id, work_date) DO NOTHING''',
            (args.employee, work_date, shift, args.reason, args.confirmed_by))
        cur.execute('''INSERT INTO frontend.attendance_punch_assignments
            (emp_id, punch_time, work_date, shift_name, role, reason, confirmed_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (emp_id, punch_time) DO NOTHING''',
            (args.employee, punch, work_date, shift, args.role, args.reason, args.confirmed_by))
        cur.execute('''UPDATE biometric_logs SET processed = FALSE
            WHERE emp_id = %s AND punch_time >= %s AND punch_time < %s''',
            (args.employee, datetime.combine(start, datetime.min.time()), datetime.combine(end + timedelta(days=1), datetime.min.time())))
        conn.commit()
        print('Confirmation saved. Reprocessing queued punches now.')
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    process_attendance()
    print('Check attendance and review flags. If another worker held the lock, it will process the queued punches.')


if __name__ == '__main__':
    main()
