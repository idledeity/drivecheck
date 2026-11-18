"""
Fakes and helpers shared by the job registry tests (test_job_registry.py,
test_batches.py). Their fixtures are in conftest.py next to this file.
"""

import sqlite3
import threading
import time

from database import db
from drives.drive_models import DriveContext, DriveDescriptor
from jobs.job_models import JobStatus
from jobs.job_registry import JobRegistry
from operations.operation import OperationBase, OperationCancelled, ParamSpec


class ControllableOperation(OperationBase):
    """Fake operation whose completion is gated by an Event, so tests can
    deterministically control dispatch ordering instead of racing real work."""
    name = "Controllable"
    category = "Test"
    tool = "none"
    params = [ParamSpec(name="fail", label="Fail", type="boolean", default=False)]

    instances: list["ControllableOperation"] = []
    unsupported_guids: set[str] = set()

    def __init__(self):
        self._release = threading.Event()
        self._cancel_event = threading.Event()
        self.started = threading.Event()
        self.params_seen = None
        self.percent = None
        type(self).instances.append(self)

    @classmethod
    def reset(cls):
        cls.instances = []
        cls.unsupported_guids = set()

    @staticmethod
    def supports(context):
        return context.guid not in ControllableOperation.unsupported_guids

    def run(self, context, params):
        self.params_seen = params
        self.started.set()
        self._release.wait(timeout=5)
        if self._cancel_event.is_set():
            raise OperationCancelled()
        if params.get("fail"):
            raise RuntimeError("boom")
        return {"ok": True, "guid": context.guid}

    def get_percent(self):
        return self.percent

    def cancel(self):
        self._cancel_event.set()

    def release(self):
        self._release.set()


class DestructiveOperation(ControllableOperation):
    name = "Destructive"
    destructive = True


def drive_context(guid: str) -> DriveContext:
    return DriveContext(
        guid=guid,
        descriptor=DriveDescriptor(device_name=f"/dev/{guid}", access_type="scsi", info_name=guid),
    )


def make_registry(max_parallel=None, guids=("d1", "d2")):
    contexts = {g: drive_context(g) for g in guids}
    return JobRegistry(max_parallel=max_parallel, get_context=contexts.get)


def wait_until(predicate, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")


class SmartRecorder:
    """Stands in for DriveCollector.capture_smart, numbering each capture."""

    def __init__(self, fail_on: int | None = None):
        self.calls: list[str] = []
        self.max_ages: list[float] = []
        self._fail_on = fail_on

    def __call__(self, guid, max_age):
        self.calls.append(guid)
        self.max_ages.append(max_age)
        if self._fail_on == len(self.calls):
            raise RuntimeError("smartctl went away")
        return {"captured_at": f"t{len(self.calls)}", "signals": {"reallocated": len(self.calls) - 1}}


def make_smart_registry(recorder, guids=("d1",)):
    contexts = {g: drive_context(g) for g in guids}
    return JobRegistry(max_parallel=None, get_context=contexts.get, capture_smart=recorder)


def job_row(job_id):
    with db._connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()


def wait_for_row(job_id, status: JobStatus):
    """Wait until the job's saved row has this status. A job thread sets the
    in-memory status just before it saves the row, so a test that waited on
    the in-memory status can't read the row straight away."""
    wait_until(lambda: (row := job_row(job_id)) is not None and row["status"] == status.value)
