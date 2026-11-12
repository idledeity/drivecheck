"""
job_models.py — Job-related data models for drivecheck.

A Job is a queued, running, or finished instance of an operation against a
single drive, tracked by JobRegistry. Pure data — no reference to the
operation instance that backs it (that lives in JobRegistry, to avoid a
job_models <-> operations import cycle).
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class JobStatus(Enum):
    QUEUED      = "queued"
    RUNNING     = "running"
    COMPLETED   = "completed"
    FAILED      = "failed"
    CANCELLED   = "cancelled"
    INTERRUPTED = "interrupted"  # was RUNNING at last shutdown; could not be confirmed or resumed


@dataclass
class Job:
    """A queued, running, or finished operation against a single drive."""
    id: str
    drive_guid: str
    operation: str   # OPERATIONS registry key, e.g. "dd_read_test"
    category: str    # operation's category at creation time, e.g. "Test" | "Scan" | "Debug"
    params: dict
    status: JobStatus = JobStatus.QUEUED
    result: dict | None = None
    error: str | None = None
    created_at: datetime = field(default_factory=datetime.now)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    # Condensed SMART snapshots from just before the operation starts and just
    # after it ends (any outcome), so a run's effect on the drive can be compared.
    # Each is DriveCollector.capture_smart()'s summary: snapshot_id (the full
    # report in drive_raw_snapshots), captured_at, signals, reused — or
    # {"captured_at", "error"} if the capture failed. Facts only: flags and health
    # are derived from signals when served. (Rows from older versions also carry
    # a stored "health", which the API ignores.)
    smart_before: dict | None = None
    smart_after: dict | None = None
    # Place in the run queue (0 starts first) while QUEUED, else None. Persisted
    # so a restart keeps the order the user set, not just creation order.
    queue_position: int | None = None
