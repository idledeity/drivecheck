"""
jobs.summary_backfill — Summary logs for jobs that finished before their
operation kept one (scripts/backfill_job_summaries.py).

Each job's operation is rebuilt from the job's stored params, plus what its
_configure() reads from the drive (the capacity recorded for it), and its raw
log is summarized exactly as a live run's would be, size limits included.
Only jobs with no summary are touched, so running it again is harmless.
"""

import json
import logging
from dataclasses import dataclass

from database import db
from drives.drive_models import DriveContext, DriveDescriptor, DriveTraits
from operations import job_logs
from operations.logged_process import LoggedProcessOperation
from operations.operation_registry import OPERATIONS

logger = logging.getLogger(__name__)


@dataclass
class BackfillOutcome:
    job_id: str
    operation: str
    status: str             # "added" | "no raw log" | "no summarizer" | "failed"
    detail: str = ""        # summary size, or why it failed


def _context_for(drive_guid: str) -> DriveContext:
    record = db.get_drive_record(drive_guid)
    capacity = record["capacity_bytes"] if record else None
    # Never used to reach a device: only the traits _configure() reads matter.
    return DriveContext(
        guid=drive_guid,
        descriptor=DriveDescriptor(device_name="", access_type="", info_name=""),
        traits=DriveTraits(capacity_bytes=capacity),
    )


def backfill_summary_logs() -> list[BackfillOutcome]:
    """Add summaries to every finished job that can have one but doesn't."""
    outcomes = []
    for row in db.get_jobs_without_summary_log():
        job_id, operation = row["id"], row["operation"]
        op_cls = OPERATIONS.get(operation)
        if op_cls is None or not issubclass(op_cls, LoggedProcessOperation):
            continue  # no raw log to summarize (e.g. SMART self-tests)
        raw_log = job_logs.existing_raw_log(job_id)
        if raw_log is None:
            outcomes.append(BackfillOutcome(job_id, operation, "no raw log"))
            continue
        try:
            text = op_cls().summarize_past_run(_context_for(row["drive_guid"]), json.loads(row["params_json"]), raw_log)
        except Exception as e:
            logger.warning("job %s: could not summarize %s", job_id[:8], raw_log, exc_info=True)
            outcomes.append(BackfillOutcome(job_id, operation, "failed", str(e) or type(e).__name__))
            continue
        if text is None:
            outcomes.append(BackfillOutcome(job_id, operation, "no summarizer"))
            continue
        text = job_logs.limit_summary(text, job_id)
        if db.set_job_summary_log_if_missing(job_id, text):
            outcomes.append(BackfillOutcome(
                job_id, operation, "added", f"{raw_log.stat().st_size:,} → {len(text.encode()):,} bytes"))
    return outcomes
