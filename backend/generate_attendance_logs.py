import logging

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger

from db.table_init import init_tables
from attendance.sync_bio import (
    sync_biometric_logs,
    backfill_unmatched_employees,
    repair_stale_unknown_backfills_once,
    repair_null_emp_records_once,
)
from attendance.attendance_processor import process_attendance

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Job 1: sync only — pulls from all scanners (ZK + Anviz) into biometric_logs.
# Runs on its own schedule/lock, so a slow/stuck Anviz device only delays
# the NEXT sync, never attendance processing.
#
# sync_biometric_logs() also calls _backfill_unmatched_records() internally
# on every run, so this job still self-heals on its own cadence too — but
# that's tied to however often device polling happens. backfill_job below
# is the dedicated, always-on version of the same fix that doesn't wait on
# scanners at all.
# ---------------------------------------------------------------------------
def sync_job():
    log.info("=" * 55)
    log.info("Job started: sync_job")
    try:
        sync_biometric_logs()
        log.info("Job complete: sync_job")
    except Exception:
        log.exception("sync_job FAILED.")


# ---------------------------------------------------------------------------
# Job 2: backfill only — re-checks every biometric_logs row still sitting at
# employee_status = 'UNKNOWN/RESIGNED' against the CURRENT
# frontend.employee_groupings roster. Any row whose emp_no now has a match
# (e.g. because an Excel import just added that employee) gets upgraded to
# ACTIVE with the real emp_id, has processed reset back to FALSE so
# process_job regenerates attendance_logs for it, and its old
# "UNKNOWN_<emp_no>" placeholder attendance_logs row is cleaned up.
#
# This is deliberately its OWN job, independent of sync_job:
#   - It never talks to a scanner/device, so it can run on a short,
#     predictable interval regardless of how long ZK/Anviz polling takes.
#   - It reacts directly to employee_groupings changes (Excel imports),
#     which is the actual trigger you care about — not to whether a sync
#     happened to fire around the same time.
# ---------------------------------------------------------------------------
def backfill_job():
    log.info("." * 55)
    log.info("Job started: backfill_job")
    try:
        updated = backfill_unmatched_employees()
        log.info(f"Job complete: backfill_job ({updated} punch(es) upgraded to ACTIVE)")
    except Exception:
        log.exception("backfill_job FAILED.")


# ---------------------------------------------------------------------------
# Job 3: attendance processing only — reads whatever is already in
# biometric_logs. Runs independently of sync_job/backfill_job, on its own
# lock, so it always executes on schedule regardless of how long those take.
# ---------------------------------------------------------------------------
def process_job():
    log.info("-" * 55)
    log.info("Job started: process_job")
    try:
        process_attendance()
        log.info("Job complete: process_job")
    except Exception:
        log.exception("process_job FAILED.")


# ---------------------------------------------------------------------------
# Startup step (NOT a recurring job): one-time repair for historical rows
# that got silently upgraded UNKNOWN/RESIGNED -> ACTIVE by the OLD version
# of _backfill_unmatched_records(), before it was fixed to also reset
# `processed`. backfill_job above only ever looks at rows still sitting at
# employee_status = 'UNKNOWN/RESIGNED' -- rows already flipped to ACTIVE by
# old code are invisible to it, so they need this separate one-time pass.
#
# Also runs repair_null_emp_records_once(): a second, independent one-time
# fix for historical biometric_logs rows inserted before unmatched punches
# started carrying their scanner's agency (`emp`) on insert. Those older
# rows have emp = NULL, which was flowing straight into attendance_logs.emp
# as a blank column. Backfills emp from scanners and resets processed so
# process_job's next run regenerates those attendance_logs rows correctly.
#
# Safe to run on every startup: both are idempotent and become no-ops the
# moment there's nothing left to repair. Deliberately NOT added to the
# scheduler as recurring jobs -- they belong at boot, once, not on a
# recurring cadence.
# ---------------------------------------------------------------------------
def run_startup_repair():
    log.info("Running one-time startup repair for historical stuck records...")
    try:
        repaired = repair_stale_unknown_backfills_once()
        if repaired:
            log.info(
                f"Startup repair: {repaired} historical row(s) reset to "
                f"processed=FALSE — process_job's next run will regenerate "
                f"attendance_logs for them."
            )
        else:
            log.info("Startup repair: nothing to repair.")
    except Exception:
        # Non-fatal: don't block the scheduler from starting just because
        # this cleanup pass hit an issue. Worst case, historical rows stay
        # stuck until this is investigated and re-run.
        log.exception("Startup repair FAILED (scheduler will still start).")

    log.info("Running one-time startup repair for historical NULL emp records...")
    try:
        repaired_emp = repair_null_emp_records_once()
        if repaired_emp:
            log.info(
                f"Startup repair: {repaired_emp} historical biometric_logs "
                f"row(s) had emp backfilled and reset to processed=FALSE — "
                f"process_job's next run will regenerate attendance_logs "
                f"for them with emp populated."
            )
        else:
            log.info("Startup repair: no NULL emp records to repair.")
    except Exception:
        log.exception("NULL emp startup repair FAILED (scheduler will still start).")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    log.info("Initializing database tables...")
    try:
        init_tables()
        log.info("Tables ready.")
    except Exception:
        log.exception("FATAL: Table initialization failed. Exiting.")
        return

    run_startup_repair()

    scheduler = BlockingScheduler(timezone="Asia/Manila")

    # Sync runs every minute, same cadence as before. If an Anviz pull runs
    # long, max_instances=1 + misfire_grace_time still protect against
    # overlapping sync runs — but process_job/backfill_job below are now
    # unaffected by it.
    scheduler.add_job(
        sync_job,
        trigger=IntervalTrigger(minutes=1),
        id="sync_job",
        name="Sync biometric logs (ZK + Anviz)",
        replace_existing=True,
        misfire_grace_time=60,
        max_instances=1,
    )

    # Backfill runs on a short, dedicated interval, independent of scanner
    # polling. This is the job that actually answers "an employee just got
    # imported — reflect that in biometric_logs/attendance_logs" without
    # waiting on device connectivity at all. Runs before process_job in this
    # list purely for readability; APScheduler doesn't guarantee ordering
    # between separate interval jobs, but running this frequently (every
    # 30s here) means process_job's next tick will pick up the reset
    # `processed = FALSE` rows either way.
    scheduler.add_job(
        backfill_job,
        trigger=IntervalTrigger(seconds=30),
        id="backfill_job",
        name="Backfill unmatched employees against current roster",
        replace_existing=True,
        misfire_grace_time=30,
        max_instances=1,
    )

    # Attendance processing runs on its own independent schedule/lock.
    # Adjust the interval to whatever cadence you actually need — it no
    # longer has to match sync_job's/backfill_job's cadence since they're
    # decoupled.
    scheduler.add_job(
        process_job,
        trigger=IntervalTrigger(minutes=1),
        id="process_job",
        name="Process attendance",
        replace_existing=True,
        misfire_grace_time=60,
        max_instances=1,
    )

    log.info("Scheduler started.")
    log.info("  • sync_job     : every minute")
    log.info("  • backfill_job : every 30 seconds")
    log.info("  • process_job  : every minute")
    log.info("Press Ctrl+C to stop.")

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("Scheduler stopped.")


if __name__ == "__main__":
    main()