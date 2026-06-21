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
    QUEUED    = "queued"
    RUNNING   = "running"
    COMPLETED = "completed"
    FAILED    = "failed"
    CANCELLED = "cancelled"


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
