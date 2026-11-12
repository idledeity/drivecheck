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
from operations.operation import OperationBase, OperationCancelled, ParamError, ParamSpec


@pytest.fixture(autouse=True)
def _init_db(isolated_data_dir):
    db.init()


class _ControllableOperation(OperationBase):
    """Fake operation whose completion is gated by an Event, so tests can
    deterministically control dispatch ordering instead of racing real work."""
    name = "Controllable"
    category = "Test"
    tool = "none"
    params = [ParamSpec(name="fail", label="Fail", type="boolean", default=False)]

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
def _wait_for_job_threads(_reset_fake_operation, monkeypatch):
    """Don't let a job thread outlive its test.

    A job thread sets its in-memory status before it saves its final row, so a
    test that waits on job.status can end while that save is still pending —
    and once isolated_data_dir is undone, the save would land outside the
    test's own database. At teardown, release every fake operation and wait
    for each registry's threads. Depends on _reset_fake_operation so it tears
    down first, while the operation instances are still listed.
    """
    registries = []
    original_init = JobRegistry.__init__

    def tracking_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        registries.append(self)

    monkeypatch.setattr(JobRegistry, "__init__", tracking_init)
    yield
    for op in _ControllableOperation.instances:
        op.release()
    for registry in registries:
        registry._executor.shutdown(wait=True)


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
        params = [ParamSpec(name="speed", label="Speed", type="number", default=5),
                  ParamSpec(name="fail", label="Fail", type="boolean", default=False)]

    monkeypatch.setattr(job_registry_module, "OPERATIONS", {"controllable": _ParamOperation})
    registry = _make_registry()
    registry.create_jobs(["d1"], "controllable", {"speed": 7.0})
    instance = _ControllableOperation.instances[0]
    instance.release()
    _wait_until(lambda: instance.params_seen is not None)
    assert instance.params_seen == {"speed": 7, "fail": False}


def test_create_jobs_rejects_bad_params_before_queuing_anything():
    registry = _make_registry()
    with pytest.raises(ParamError) as exc:
        registry.create_jobs(["d1", "d2"], "controllable", {"fail": "yes"})
    assert exc.value.field == "fail"
    assert registry.list_jobs() == []
    assert _ControllableOperation.instances == []


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


# ---------------------------------------------------------------------------
# Drive lock, re-checked when a destructive job starts
# ---------------------------------------------------------------------------

class _DestructiveOperation(_ControllableOperation):
    name = "Destructive"
    destructive = True


def _make_lock_registry(monkeypatch, op_cls, locked: set[str]):
    monkeypatch.setattr(job_registry_module, "OPERATIONS", {"op": op_cls})
    contexts = {g: _context(g) for g in ("d1", "d2")}
    recorder = _SmartRecorder()
    registry = JobRegistry(max_parallel=1, get_context=contexts.get, capture_smart=recorder,
                           is_locked=lambda g: g in locked)
    return registry, recorder


def test_a_destructive_job_fails_if_its_drive_was_locked_while_queued(monkeypatch):
    locked: set[str] = set()
    registry, recorder = _make_lock_registry(monkeypatch, _DestructiveOperation, locked)
    first, queued = registry.create_jobs(["d1", "d2"], "op", {})
    assert queued.status == JobStatus.QUEUED

    locked.add("d2")
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: queued.status == JobStatus.FAILED)

    assert "locked" in queued.error
    assert not _ControllableOperation.instances[1].started.is_set()  # never ran
    assert queued.smart_before is None and queued.smart_after is None
    assert recorder.calls == ["d1", "d1"]  # only the first job's before/after
    assert db.get_job_history("d2")[0]["status"] == "failed"
    assert first.status == JobStatus.COMPLETED


def test_the_lock_doesnt_stop_a_non_destructive_job(monkeypatch):
    registry, _ = _make_lock_registry(monkeypatch, _ControllableOperation, {"d1"})
    job = registry.create_jobs(["d1"], "op", {})[0]
    _ControllableOperation.instances[0].release()
    _wait_until(lambda: job.status == JobStatus.COMPLETED)


# ---------------------------------------------------------------------------
# Queue order: moving queued jobs, and keeping the order across a restart
# ---------------------------------------------------------------------------

def _positions(*jobs):
    return [_job_row(j.id)["queue_position"] for j in jobs]


def test_moving_a_queued_job_changes_which_runs_next_on_its_drive():
    registry = _make_registry()
    running, second, third = (registry.create_jobs(["d1"], "controllable", {})[0] for _ in range(3))
    assert running.status == JobStatus.RUNNING
    assert _positions(running, second, third) == [None, 0, 1]

    assert registry.move_job(third.id, -1) is True
    assert (third.queue_position, second.queue_position) == (0, 1)
    assert _positions(second, third) == [1, 0]

    _ControllableOperation.instances[0].release()
    _wait_until(lambda: third.status == JobStatus.RUNNING)
    assert second.status == JobStatus.QUEUED
    assert third.queue_position is None and _positions(second, third) == [0, None]


def test_move_reports_jobs_it_cannot_move():
    registry = _make_registry()
    running, first, last = (registry.create_jobs(["d1"], "controllable", {})[0] for _ in range(3))
    assert registry.move_job(first.id, -1) is False
    assert registry.move_job(last.id, 1) is False
    assert registry.move_job(running.id, 1) is None
    assert registry.move_job("nonexistent-id", 1) is None
    with pytest.raises(ValueError):
        registry.move_job(first.id, 2)


def test_move_only_reorders_within_a_drive():
    registry = _make_registry(max_parallel=1)
    registry.create_jobs(["d1"], "controllable", {})       # runs, taking the only slot
    [other] = registry.create_jobs(["d2"], "controllable", {})
    [mine] = registry.create_jobs(["d1"], "controllable", {})
    # The d2 job is ahead in the queue, but it is not this drive's job to swap with.
    assert registry.move_job(mine.id, -1) is False
    assert (other.queue_position, mine.queue_position) == (0, 1)


def test_cancelling_a_queued_job_renumbers_the_rest():
    registry = _make_registry()
    _running, a, b, c = (registry.create_jobs(["d1"], "controllable", {})[0] for _ in range(4))
    assert registry.cancel_job(b.id) is True
    assert _positions(a, b, c) == [0, None, 1]


def test_recovery_restores_the_saved_queue_order():
    # Created in one order, reordered before the restart: the saved positions win.
    for job_id, created, pos in (("early", datetime(2026, 1, 1), 1), ("late", datetime(2026, 1, 2), 0)):
        db.record_job(Job(id=job_id, drive_guid="d1", operation="controllable", category="Test",
                          params={}, created_at=created, queue_position=pos))
    registry = _make_registry()
    registry.recover()
    jobs = {j.id: j for j in registry.list_jobs()}
    assert jobs["late"].status == JobStatus.RUNNING
    assert jobs["early"].status == JobStatus.QUEUED and jobs["early"].queue_position == 0
