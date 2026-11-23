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
from system_utils import clock


class JobStatus(Enum):
    QUEUED      = "queued"
    RUNNING     = "running"
    COMPLETED   = "completed"
    FAILED      = "failed"
    CANCELLED   = "cancelled"
    INTERRUPTED = "interrupted"  # was RUNNING at last shutdown; could not be confirmed or resumed
    SKIPPED     = "skipped"      # a batch step that never ran: an earlier step failed, or the drive can't run it


@dataclass
class Batch:
    """One drive's run of a recipe: a block of steps (ordinary Jobs carrying
    its id) that queue together, keep their order, and move and cancel as one.
    Starting a recipe on several drives makes one batch per drive. Facts only —
    the batch's outcome is derived from its jobs when served."""
    id: str
    drive_guid: str
    recipe: str           # RECIPES registry key, e.g. "initial_scan"
    params: dict          # the recipe's own params, validated
    stop_on_failure: bool # a step that doesn't complete skips the batch's remaining steps
    created_at: datetime = field(default_factory=clock.now)


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
    created_at: datetime = field(default_factory=clock.now)
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
    # The important lines of the run's raw output (OperationBase.get_summary_log),
    # set when the job ends; None for operations that keep no summary. Stored in
    # the row so it outlives the raw log file.
    summary_log: str | None = None
    # Set on a recipe's steps: the Batch they belong to, the step's index in
    # its drive's plan (0-based), and the step's Check as stored data
    # (recipes.recipe.Check.to_dict), if it has one.
    batch_id: str | None = None
    batch_step: int | None = None
    step_check: dict | None = None
