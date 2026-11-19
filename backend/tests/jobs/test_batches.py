"""Batches: a recipe's steps queued as jobs on each drive, run in order, with
a failed step skipping the rest of that drive's chain."""

import json

import pytest

from database import db
from jobs import job_registry as job_registry_module
from jobs.job_models import JobStatus
from operations.operation import ParamError, ParamSpec
from recipes.recipe import Check, Recipe, RecipeError, Step

from job_fakes import (
    ControllableOperation, DestructiveOperation, SmartRecorder, job_row, make_registry,
    make_smart_registry, wait_until,
)


class _FailIf(Check):
    """Test check: fails the step when told to, and records what it saw."""
    kind = "test_fail_if"
    seen: list = []

    def __init__(self, fail: bool):
        self.fail = fail

    def args(self):
        return {"fail": self.fail}

    def evaluate(self, job):
        _FailIf.seen.append((job.id, job.status, job.smart_after))
        return "drive got worse" if self.fail else None


class _UnsupportedOperation(ControllableOperation):
    name = "Unsupported"

    @staticmethod
    def supports(context):
        return False


class _ThreeSteps(Recipe):
    """Three controllable steps; params pick which fails (by its own run or its check)."""
    name = "Three steps"
    description = "test recipe"
    params = [
        ParamSpec(name="fail_step", label="Fail step", type="number", default=-1, min=-1, max=2),
        ParamSpec(name="check_fails_step", label="Check fails step", type="number", default=-1, min=-1, max=2),
    ]

    def plan(self, context, params):
        return [
            Step("controllable", {"fail": i == params["fail_step"]},
                 check=_FailIf(i == params["check_fails_step"]) if params["check_fails_step"] >= 0 else None)
            for i in range(3)
        ]


class _WithUnsupported(Recipe):
    name = "With unsupported"
    description = "test recipe"
    params = [ParamSpec(name="if_unsupported", label="If unsupported", type="string", default="skip")]

    def plan(self, context, params):
        return [Step("controllable"), Step("unsupported", if_unsupported=params["if_unsupported"]),
                Step("controllable")]


class _SneakyDestructive(Recipe):
    name = "Sneaky"
    description = "plans a destructive step without declaring it"

    def plan(self, context, params):
        return [Step("controllable"), Step("destructive")]


class _BadStepParams(Recipe):
    name = "Bad params"
    description = "plans params the operation doesn't take"

    def plan(self, context, params):
        return [Step("controllable", {"nope": 1})]


@pytest.fixture(autouse=True)
def _fake_recipes(monkeypatch):
    _FailIf.seen = []
    monkeypatch.setattr(job_registry_module, "OPERATIONS", {
        "controllable": ControllableOperation,
        "unsupported": _UnsupportedOperation,
        "destructive": DestructiveOperation,
    })
    monkeypatch.setattr(job_registry_module, "RECIPES", {
        "three": _ThreeSteps, "with_unsupported": _WithUnsupported,
        "sneaky": _SneakyDestructive, "bad_params": _BadStepParams,
    })


def _start(registry, recipe="three", params=None, **kwargs):
    """Start a recipe on d1 alone; returns its one batch and that batch's jobs."""
    [(batch, jobs)] = registry.create_batches(["d1"], recipe, params or {}, **kwargs)
    return batch, jobs


def _steps(registry, batch_id):
    return sorted((j for j in registry.list_jobs() if j.batch_id == batch_id), key=lambda j: j.batch_step)


def _statuses(registry, batch_id):
    return [j.status for j in _steps(registry, batch_id)]


def _finish(registry, batch_id, step):
    """Release one step's operation and wait for it to end."""
    job = _steps(registry, batch_id)[step]
    instance = registry._instances[job.id]
    wait_until(instance.started.is_set)
    instance.release()
    wait_until(lambda: job.status not in (JobStatus.QUEUED, JobStatus.RUNNING))


def _positions(jobs):
    return [j.queue_position for j in jobs]


Q, R, C, F, S, X = (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.COMPLETED,
                    JobStatus.FAILED, JobStatus.SKIPPED, JobStatus.CANCELLED)


# --- Creating batches --------------------------------------------------------

def test_create_batches_returns_none_for_unknown_recipe():
    assert make_registry().create_batches(["d1"], "nope", {}) is None


def test_create_batches_rejects_bad_recipe_params_before_queueing():
    registry = make_registry()
    with pytest.raises(ParamError):
        registry.create_batches(["d1"], "three", {"fail_step": 7})
    assert registry.list_jobs() == []


def test_each_drive_gets_its_own_batch():
    registry = make_registry()
    created = registry.create_batches(["d1", "d2", "unknown"], "three", {})
    assert [b.drive_guid for b, _ in created] == ["d1", "d2"]
    assert created[0][0].id != created[1][0].id
    for batch, jobs in created:
        assert [(j.drive_guid, j.batch_id, j.batch_step) for j in jobs] == [(batch.drive_guid, batch.id, i) for i in range(3)]
        assert batch.params == {"fail_step": -1, "check_fails_step": -1}
        assert batch.stop_on_failure is True  # recipe default


def test_a_batch_runs_its_steps_in_order():
    registry = make_registry()
    batch, _ = _start(registry)
    assert _statuses(registry, batch.id) == [R, Q, Q]
    _finish(registry, batch.id, 0)
    wait_until(lambda: _statuses(registry, batch.id) == [C, R, Q])
    _finish(registry, batch.id, 1)
    _finish(registry, batch.id, 2)
    assert _statuses(registry, batch.id) == [C, C, C]


def test_batch_and_its_steps_are_persisted():
    registry = make_registry()
    batch, jobs = _start(registry, params={"check_fails_step": 1}, stop_on_failure=False)
    stored = db.get_batches([batch.id])[batch.id]
    assert (stored.drive_guid, stored.recipe, stored.params, stored.stop_on_failure) == (
        "d1", "three", batch.params, False)
    row = job_row(jobs[1].id)
    assert (row["batch_id"], row["batch_step"]) == (batch.id, 1)
    assert json.loads(row["step_check_json"]) == {"kind": "test_fail_if", "fail": True}


def test_unsupported_step_marked_skip_is_recorded_skipped():
    registry = make_registry()
    batch, jobs = _start(registry, "with_unsupported")
    assert [j.status for j in jobs] == [R, S, Q]
    assert jobs[1].error == "Not supported on this drive" and jobs[1].queue_position is None
    _finish(registry, batch.id, 0)
    wait_until(lambda: jobs[2].status == R)  # a skipped-as-unsupported step doesn't stop the chain


def test_unsupported_step_marked_fail_leaves_the_drive_out():
    registry = make_registry()
    assert registry.create_batches(["d1"], "with_unsupported", {"if_unsupported": "fail"}) == []
    with db._connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM batches").fetchone()[0] == 0


def test_plan_batches_says_what_each_drive_would_run_without_queueing():
    registry = make_registry(guids=("d1", "d2"))
    merged, plans = registry.plan_batches(["d1", "gone", "d2"], "with_unsupported", {})
    assert merged == {"if_unsupported": "skip"}
    assert [(p.guid, p.excluded) for p in plans] == [("d1", None), ("gone", "Drive not found"), ("d2", None)]
    assert [(s.step.operation, s.supported) for s in plans[0].steps] == [
        ("controllable", True), ("unsupported", False), ("controllable", True),
    ]
    assert registry.list_jobs() == [] and db.get_job_history() == []


def test_plan_batches_gives_why_a_drive_is_left_out():
    _, plans = make_registry().plan_batches(["d1"], "with_unsupported", {"if_unsupported": "fail"})
    assert plans[0].steps is None and "which the recipe requires" in plans[0].excluded


def test_an_undeclared_destructive_step_is_refused_with_nothing_queued():
    registry = make_registry()
    with pytest.raises(RecipeError, match="destructive"):
        registry.create_batches(["d1"], "sneaky", {})
    assert registry.list_jobs() == []


def test_step_params_that_do_not_fit_the_operation_are_a_recipe_error():
    registry = make_registry()
    with pytest.raises(RecipeError, match="nope"):
        registry.create_batches(["d1"], "bad_params", {})
    assert registry.list_jobs() == []


# --- Failed steps and checks -------------------------------------------------

def test_a_failed_step_skips_the_rest_of_its_batch_only():
    registry = make_registry()
    (b1, _), (b2, _) = registry.create_batches(["d1", "d2"], "three", {"fail_step": 0})
    _finish(registry, b1.id, 0)
    wait_until(lambda: _statuses(registry, b1.id) == [F, S, S])
    skipped = _steps(registry, b1.id)[1]
    assert skipped.error == "Not run: step 1 (Controllable) failed"
    assert skipped.queue_position is None
    assert job_row(skipped.id)["status"] == JobStatus.SKIPPED.value
    assert _statuses(registry, b2.id) == [R, Q, Q]  # the other drive's batch is untouched


def test_failed_step_carries_on_when_the_batch_does_not_stop_on_failure():
    registry = make_registry()
    batch, _ = _start(registry, params={"fail_step": 0}, stop_on_failure=False)
    _finish(registry, batch.id, 0)
    wait_until(lambda: _statuses(registry, batch.id) == [F, R, Q])


def test_a_failed_check_fails_the_step_after_its_after_snapshot():
    registry = make_smart_registry(SmartRecorder())
    batch, _ = _start(registry, params={"check_fails_step": 0})
    _finish(registry, batch.id, 0)
    first = _steps(registry, batch.id)[0]
    assert first.status == F and first.error == "drive got worse"
    assert first.result == {"ok": True, "guid": "d1"}  # the run's own result is kept
    # The check ran while the job was still RUNNING, with its after snapshot taken
    assert _FailIf.seen == [(first.id, R, {"captured_at": "t2", "signals": {"reallocated": 1}})]
    wait_until(lambda: _statuses(registry, batch.id) == [F, S, S])


def test_a_passing_check_completes_the_step():
    registry = make_registry()
    batch, _ = _start(registry, params={"check_fails_step": 2})  # only step 2 has a failing check
    _finish(registry, batch.id, 0)
    _finish(registry, batch.id, 1)
    _finish(registry, batch.id, 2)
    assert _statuses(registry, batch.id) == [C, C, F]


def test_a_check_that_cannot_run_fails_the_step():
    registry = make_registry()
    batch, jobs = _start(registry, params={"check_fails_step": 0})
    jobs[0].step_check = {"kind": "gone"}
    _finish(registry, batch.id, 0)
    assert jobs[0].status == F and jobs[0].error.startswith("Step check could not run")


# --- Moving: a batch is one place in its drive's queue -------------------------

def test_batch_steps_cannot_be_moved_one_by_one():
    registry = make_registry()
    _, jobs = _start(registry)
    assert registry.move_job(jobs[1].id, 1) is False
    assert registry.move_job(jobs[2].id, -1) is False


def test_a_job_moving_past_a_batch_passes_all_its_queued_steps():
    registry = make_registry()
    registry.create_jobs(["d1"], "controllable", {})  # holds the drive
    _, steps = _start(registry)
    [solo] = registry.create_jobs(["d1"], "controllable", {})
    assert registry.move_job(solo.id, -1) is True
    assert solo.queue_position == 0 and _positions(steps) == [1, 2, 3]
    assert registry.move_job(solo.id, -1) is False  # already first
    assert registry.move_job(solo.id, 1) is True    # and back past the whole batch
    assert solo.queue_position == 3


def test_move_batch_moves_its_steps_together_past_the_next_unit():
    registry = make_registry()
    registry.create_jobs(["d1"], "controllable", {})  # holds the drive
    b1, first = _start(registry)
    b2, second = _start(registry)
    [solo] = registry.create_jobs(["d1"], "controllable", {})
    assert registry.move_batch(b2.id, -1) is True    # past b1 as one place
    assert _positions(second) == [0, 1, 2] and _positions(first) == [3, 4, 5]
    assert registry.move_batch(b2.id, -1) is False   # already first
    assert registry.move_batch(b1.id, 1) is True     # past the solo job
    assert solo.queue_position == 3 and _positions(first) == [4, 5, 6]
    assert registry.move_batch(b1.id, 1) is False    # already last
    assert registry.move_batch("unknown", 1) is None


def test_move_batch_leaves_other_drives_jobs_in_place():
    registry = make_registry()
    registry.create_jobs(["d1"], "controllable", {})  # holds d1
    b1, first = _start(registry)
    [other] = registry.create_jobs(["d2"], "controllable", {})  # runs on d2
    [other_queued] = registry.create_jobs(["d2"], "controllable", {})
    [solo] = registry.create_jobs(["d1"], "controllable", {})
    before = other_queued.queue_position
    assert registry.move_batch(b1.id, 1) is True
    assert solo.queue_position == 0 and _positions(first) == [1, 2, 4]  # d2's job keeps its place
    assert other_queued.queue_position == before == 3


def test_a_started_batch_keeps_its_remaining_steps_next():
    registry = make_registry()
    b1, first = _start(registry)                      # step 0 running on d1
    b2, second = _start(registry)
    [solo] = registry.create_jobs(["d1"], "controllable", {})
    assert first[0].status == R and registry.batch_started(b1.id)
    assert registry.move_batch(b1.id, 1) is False     # can't be moved...
    assert registry.move_batch(b2.id, -1) is False    # ...or passed by a batch
    assert registry.move_job(solo.id, -1) is True     # (passes b2)
    assert registry.move_job(solo.id, -1) is False    # ...or by a job
    assert _positions(first[1:]) == [0, 1]
    assert not registry.batch_started(b2.id)


def test_move_batch_returns_none_once_nothing_is_queued():
    registry = make_registry()
    batch, jobs = _start(registry, params={"fail_step": 0})
    _finish(registry, batch.id, 0)
    wait_until(lambda: _statuses(registry, batch.id) == [F, S, S])
    assert registry.move_batch(batch.id, 1) is None


# --- Cancelling ------------------------------------------------------------

def test_cancelling_a_queued_step_skips_the_steps_after_it():
    registry = make_registry()
    batch, jobs = _start(registry)
    assert registry.cancel_job(jobs[1].id) is True
    assert _statuses(registry, batch.id) == [R, X, S]  # synchronous: under the lock


def test_cancel_batch_cancels_its_queued_and_running_steps_only():
    registry = make_registry()
    (b1, j1), (b2, _) = registry.create_batches(["d1", "d2"], "three", {})
    wait_until(lambda: registry._instances[j1[0].id].started.is_set())
    assert registry.cancel_batch(b1.id) == 3
    registry._instances[j1[0].id].release()  # the fake notices cancel once released
    wait_until(lambda: _statuses(registry, b1.id) == [X, X, X])
    assert _statuses(registry, b2.id) == [R, Q, Q]
    assert registry.cancel_batch("unknown") is None


# --- Restart recovery --------------------------------------------------------

def test_recovery_restores_batch_steps_and_stops_the_chain_of_an_interrupted_one():
    registry = make_registry()
    batch, jobs = _start(registry, params={"check_fails_step": 2})
    wait_until(lambda: registry._instances[jobs[0].id].started.is_set())
    registry.shutdown()  # step 0 stays RUNNING in the DB; the fake can't reattach

    restarted = make_registry()
    restarted.recover()
    wait_until(lambda: job_row(jobs[0].id)["status"] == JobStatus.INTERRUPTED.value)
    for job in jobs[1:]:
        row = job_row(job.id)
        assert (row["status"], row["batch_id"], row["batch_step"]) == (JobStatus.SKIPPED.value, batch.id, job.batch_step)
        assert row["error"] == "Not run: step 1 (Controllable) interrupted"
    assert json.loads(job_row(jobs[2].id)["step_check_json"]) == {"kind": "test_fail_if", "fail": True}


def test_recovery_keeps_a_batch_movable_and_cancellable():
    registry = make_registry()
    registry.create_jobs(["d1"], "controllable", {})  # holds the drive
    batch, jobs = _start(registry)
    waiting, _ = _start(registry)
    [solo] = registry.create_jobs(["d1"], "controllable", {})
    registry.shutdown()

    restarted = make_registry()
    restarted.recover()  # the blocker can't reattach: interrupted, so the batch starts
    wait_until(lambda: restarted._jobs[jobs[0].id].status == R)
    assert restarted.move_batch(batch.id, 1) is False   # started: stays next
    assert restarted.move_batch(waiting.id, 1) is True
    assert restarted._jobs[solo.id].queue_position == 2
    assert restarted.cancel_batch(batch.id) == 3


def test_recovery_marking_a_step_interrupted_keeps_its_batch(monkeypatch):
    registry = make_registry()
    batch, jobs = _start(registry)
    wait_until(lambda: registry._instances[jobs[0].id].started.is_set())
    registry.shutdown()

    monkeypatch.setattr(job_registry_module, "OPERATIONS", {})  # operation removed: every row interrupted
    restarted = make_registry()
    restarted.recover()
    rows = [job_row(j.id) for j in jobs]
    assert [r["status"] for r in rows] == [JobStatus.INTERRUPTED.value] * 3
    assert all(r["batch_id"] == batch.id for r in rows)
