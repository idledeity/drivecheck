import json
import sqlite3
import threading
import time
from datetime import datetime

import pytest

from database import db
from drives.drive_models import DriveContext, DriveDescriptor
from jobs import job_registry as job_registry_module
from jobs.job_models import Job, JobStatus
from jobs.job_registry import JobRegistry
from operations.operation import OperationBase, OperationCancelled, ParamSpec


@pytest.fixture(autouse=True)
def _init_db(isolated_data_dir):
    db.init()


class _ControllableOperation(OperationBase):
    """Fake operation whose completion is gated by an Event, so tests can
    deterministically control dispatch ordering instead of racing real work."""
    name = "Controllable"
    category = "Test"
    tool = "none"
    params = []

    instances: list["_ControllableOperation"] = []
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
        return context.guid not in _ControllableOperation.unsupported_guids

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


@pytest.fixture(autouse=True)
def _reset_fake_operation():
    _ControllableOperation.reset()
    yield
    _ControllableOperation.reset()


@pytest.fixture(autouse=True)
def _fake_operations_registry(monkeypatch):
    """create_jobs() reads job_registry's own OPERATIONS binding — patch that
    name directly rather than operations.operation_registry.OPERATIONS, since
    the two would otherwise be the same shared dict object."""
    monkeypatch.setattr(job_registry_module, "OPERATIONS", {"controllable": _ControllableOperation})


def _context(guid: str) -> DriveContext:
    return DriveContext(
        guid=guid,
        descriptor=DriveDescriptor(device_name=f"/dev/{guid}", access_type="scsi", info_name=guid),
    )


def _make_registry(max_parallel=None, guids=("d1", "d2")):
    contexts = {g: _context(g) for g in guids}
    return JobRegistry(max_parallel=max_parallel, get_context=contexts.get)


def _wait_until(predicate, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")


def test_create_jobs_returns_none_for_unknown_operation():
    registry = _make_registry()
    assert registry.create_jobs(["d1"], "nonexistent_op", {}) is None


def test_create_jobs_skips_unknown_drive():
    registry = _make_registry()
    created = registry.create_jobs(["unknown-guid"], "controllable", {})
    assert created == []


def test_create_jobs_skips_drive_that_does_not_support_operation():
    _ControllableOperation.unsupported_guids.add("d1")
    registry = _make_registry()
    created = registry.create_jobs(["d1", "d2"], "controllable", {})
    assert [job.drive_guid for job in created] == ["d2"]
    _ControllableOperation.instances[0].release()


def test_create_jobs_merges_default_params_with_overrides(monkeypatch):
    class _ParamOperation(_ControllableOperation):
        params = [ParamSpec(name="speed", label="Speed", type="number", default=5)]

    monkeypatch.setattr(job_registry_module, "OPERATIONS", {"controllable": _ParamOperation})
    registry = _make_registry()
    registry.create_jobs(["d1"], "controllable", {"extra": True})
    instance = _ControllableOperation.instances[0]
    instance.release()
    _wait_until(lambda: instance.params_seen is not None)
    assert instance.params_seen == {"speed": 5, "extra": True}


def test_create_jobs_dispatches_immediately_when_a_slot_is_free():
    registry = _make_registry()
    created = registry.create_jobs(["d1"], "controllable", {})
    assert len(created) == 1
    assert created[0].status == JobStatus.RUNNING
    assert created[0].started_at is not None
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: registry.list_jobs()[0].status == JobStatus.COMPLETED)


def test_max_parallel_caps_concurrent_jobs():
    registry = _make_registry(max_parallel=1)
    created = registry.create_jobs(["d1", "d2"], "controllable", {})
    assert created[0].status == JobStatus.RUNNING
    assert created[1].status == JobStatus.QUEUED

    _ControllableOperation.instances[0].release()
    _wait_until(lambda: created[1].status == JobStatus.RUNNING)

    _ControllableOperation.instances[1].release()
    _wait_until(lambda: created[1].status == JobStatus.COMPLETED)


def test_per_drive_exclusivity_even_with_unlimited_parallelism():
    registry = _make_registry(max_parallel=None)
    job1 = registry.create_jobs(["d1"], "controllable", {})[0]
    job2 = registry.create_jobs(["d1"], "controllable", {})[0]
    assert job1.status == JobStatus.RUNNING
    assert job2.status == JobStatus.QUEUED

    _ControllableOperation.instances[0].release()
    _wait_until(lambda: job2.status == JobStatus.RUNNING)
    _ControllableOperation.instances[1].release()
    _wait_until(lambda: job2.status == JobStatus.COMPLETED)


def test_job_completion_persists_to_db_history():
    registry = _make_registry()
    job = registry.create_jobs(["d1"], "controllable", {})[0]
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: registry.list_jobs()[0].status == JobStatus.COMPLETED)
    history = db.get_job_history("d1")
    assert len(history) == 1
    assert history[0]["id"] == job.id
    assert history[0]["status"] == "completed"


def test_job_failure_is_recorded_with_error():
    registry = _make_registry()
    job = registry.create_jobs(["d1"], "controllable", {"fail": True})[0]
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: registry.list_jobs()[0].status == JobStatus.FAILED)
    assert job.error == "boom"
    history = db.get_job_history("d1")
    assert history[0]["status"] == "failed"
    assert history[0]["error"] == "boom"


def test_cancel_unknown_job_returns_false():
    registry = _make_registry()
    assert registry.cancel_job("nonexistent-id") is False


def test_cancel_queued_job():
    registry = _make_registry(max_parallel=1)
    created = registry.create_jobs(["d1", "d2"], "controllable", {})
    queued_job = created[1]
    assert queued_job.status == JobStatus.QUEUED

    assert registry.cancel_job(queued_job.id) is True
    assert queued_job.status == JobStatus.CANCELLED
    assert queued_job.finished_at is not None
    history = db.get_job_history("d2")
    assert history[0]["status"] == "cancelled"

    _ControllableOperation.instances[0].release()
    _wait_until(lambda: created[0].status == JobStatus.COMPLETED)


def test_cancel_running_job_requests_cancellation():
    registry = _make_registry()
    job = registry.create_jobs(["d1"], "controllable", {})[0]
    instance = _ControllableOperation.instances[0]
    _wait_until(lambda: instance.started.is_set())

    assert registry.cancel_job(job.id) is True
    instance.release()
    _wait_until(lambda: job.status == JobStatus.CANCELLED)


def test_cancel_already_finished_job_returns_false():
    registry = _make_registry()
    job = registry.create_jobs(["d1"], "controllable", {})[0]
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: job.status == JobStatus.COMPLETED)
    assert registry.cancel_job(job.id) is False


def test_get_progress_returns_none_for_unknown_job():
    registry = _make_registry()
    assert registry.get_progress("nonexistent-id") is None


def test_get_progress_extrapolates_eta_from_percent_and_elapsed():
    registry = _make_registry()
    job = registry.create_jobs(["d1"], "controllable", {})[0]
    _ControllableOperation.instances[0].percent = 50
    progress = registry.get_progress(job.id)
    assert progress.percent == 50
    assert progress.eta_seconds is not None
    assert progress.eta_seconds >= 0
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: job.status == JobStatus.COMPLETED)


# ---------------------------------------------------------------------------
# SMART snapshots around a run
# ---------------------------------------------------------------------------

class _SmartRecorder:
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


def _make_smart_registry(recorder, guids=("d1",)):
    contexts = {g: _context(g) for g in guids}
    return JobRegistry(max_parallel=None, get_context=contexts.get, capture_smart=recorder)


def _job_row(job_id):
    with db._connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()


def test_smart_before_is_taken_and_saved_before_the_operation_runs():
    recorder = _SmartRecorder()
    registry = _make_smart_registry(recorder)
    [job] = registry.create_jobs(["d1"], "controllable", {})
    op = _ControllableOperation.instances[0]
    assert op.started.wait(2)
    assert recorder.calls == ["d1"]
    assert json.loads(_job_row(job.id)["smart_before_json"]) == {"captured_at": "t1", "signals": {"reallocated": 0}}
    op.release()
    _wait_until(lambda: job.status == JobStatus.COMPLETED)


def test_smart_after_is_taken_once_the_run_ends_and_saved_with_it():
    recorder = _SmartRecorder()
    registry = _make_smart_registry(recorder)
    [job] = registry.create_jobs(["d1"], "controllable", {})
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: _job_row(job.id)["status"] == JobStatus.COMPLETED.value)
    row = _job_row(job.id)
    assert json.loads(row["smart_after_json"]) == {"captured_at": "t2", "signals": {"reallocated": 1}}
    assert json.loads(row["smart_before_json"])["captured_at"] == "t1"


def test_before_may_reuse_a_recent_snapshot_but_after_never_does():
    recorder = _SmartRecorder()
    registry = _make_smart_registry(recorder)
    [job] = registry.create_jobs(["d1"], "controllable", {})
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: _job_row(job.id)["status"] == JobStatus.COMPLETED.value)
    assert recorder.max_ages == [300, 0]  # jobs.smart_snapshot_reuse_seconds default, then always new


def test_smart_after_is_taken_for_a_failed_run_too():
    recorder = _SmartRecorder()
    registry = _make_smart_registry(recorder)
    [job] = registry.create_jobs(["d1"], "controllable", {"fail": True})
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: _job_row(job.id)["status"] == JobStatus.FAILED.value)
    assert json.loads(_job_row(job.id)["smart_after_json"])["captured_at"] == "t2"


def test_a_failed_snapshot_is_recorded_and_does_not_fail_the_job():
    recorder = _SmartRecorder(fail_on=1)
    registry = _make_smart_registry(recorder)
    [job] = registry.create_jobs(["d1"], "controllable", {})
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: _job_row(job.id)["status"] == JobStatus.COMPLETED.value)
    before = json.loads(_job_row(job.id)["smart_before_json"])
    assert before["error"] == "smartctl went away"


def test_no_snapshots_without_a_capture_function():
    registry = _make_registry(guids=("d1",))
    [job] = registry.create_jobs(["d1"], "controllable", {})
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: _job_row(job.id)["status"] == JobStatus.COMPLETED.value)
    row = _job_row(job.id)
    assert row["smart_before_json"] is None and row["smart_after_json"] is None


def _saved_running_job(job_id, smart_before):
    db.record_job(Job(
        id=job_id, drive_guid="d1", operation="controllable", category="Test", params={},
        status=JobStatus.RUNNING, started_at=datetime.now(), smart_before=smart_before,
    ), {"pid": 1})


def test_recovery_keeps_the_saved_before_snapshot_and_does_not_retake_it():
    # The fake operation can't reattach, so the job ends INTERRUPTED — what
    # matters here is that the pre-restart snapshot survives that path.
    _saved_running_job("job-r", {"captured_at": "before-restart", "signals": {"reallocated": 0}})
    recorder = _SmartRecorder()
    registry = _make_smart_registry(recorder)
    registry.recover()
    _wait_until(lambda: _job_row("job-r")["status"] == JobStatus.INTERRUPTED.value)
    row = _job_row("job-r")
    assert json.loads(row["smart_before_json"])["captured_at"] == "before-restart"
    assert json.loads(row["smart_after_json"])["captured_at"] == "t1"  # only the after was taken
    assert recorder.calls == ["d1"]


def test_marking_a_missing_drive_interrupted_keeps_the_before_snapshot():
    _saved_running_job("job-m", {"captured_at": "before-restart", "signals": {}})
    registry = JobRegistry(max_parallel=None, get_context=lambda _g: None, capture_smart=_SmartRecorder())
    registry.recover()
    row = _job_row("job-m")
    assert row["status"] == JobStatus.INTERRUPTED.value
    assert json.loads(row["smart_before_json"])["captured_at"] == "before-restart"
