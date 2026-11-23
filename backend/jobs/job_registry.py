"""
job_registry.py — In-memory job queue + scheduler for the Operations/Jobs system.

Jobs are created against one or more drives and run via operation instances
from operations.operation_registry.OPERATIONS. Dispatch enforces two constraints:
  - at most `max_parallel` jobs running at once, across all drives (if
    max_parallel is None, this constraint is a no-op -- see _dispatch)
  - at most one running job per drive

Recipes (recipes.recipe) run as batches: create_batches() gives each selected
drive its own Batch and queues all of its steps at once as ordinary jobs
tagged with it, so the per-drive FIFO runs them in order. A batch's queued
steps stay together: they can't be reordered among themselves, and the batch
moves (move_batch) and cancels (cancel_batch) as one unit. When a step ends
other than COMPLETED and its batch stops on failure, its remaining steps are
marked SKIPPED before anything else is dispatched.

Dispatch is event-driven — triggered on job creation and again when a job
finishes (freeing its drive and/or a worker slot) — so no separate scheduler
thread is needed.

Active job state is persisted to the `jobs` table as it changes (on creation,
at RUNNING-transition, and once operation-specific reattach data is captured)
so that recover() can restore QUEUED/RUNNING jobs after a process restart.
"""

import json
import logging
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace

from settings import cfg
from system_utils import clock
from database import db

logger = logging.getLogger(__name__)
from operations import job_logs
from operations.operation import (
    OperationBase, OperationCancelled, OperationProgress, ReattachFailed, validate_params,
)
from operations.operation_registry import OPERATIONS
from drives.drive_models import DriveContext
from jobs.job_models import Batch, Job, JobStatus
from recipes.recipe import Check, DriveExcluded, PlannedStep, plan_for_drive
from recipes.recipe_registry import RECIPES


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

cfg.register("jobs.max_parallel",
    default=None, type="int", label="Max parallel jobs",
    section="Jobs", description="Cap on simultaneously-running jobs across all drives.",
    tooltip="Each drive already runs one job at a time, so with no limit every drive can be "
            "tested at once. Set a cap when drives share bandwidth (one controller, SAS "
            "expander or USB hub) or when running them all heats up the enclosure.",
    none_label="No limit",
    min=1, max=64, restart_required=True,
)

# Worker threads are started only as jobs need them; _dispatch alone decides how
# many run. Large enough never to be the limit: jobs resumed after a restart
# bypass max_parallel, and with no cap every drive may run at once.
_EXECUTOR_THREADS = 256


def _json_or_none(text: str | None):
    return json.loads(text) if text else None


cfg.register("jobs.smart_snapshot_reuse_seconds",
    default=300, type="int", label="SMART snapshot reuse window",
    section="Jobs",
    description="Seconds a drive's latest saved SMART snapshot counts as fresh enough to be a job's "
                "\"before\" snapshot instead of taking a new one — e.g. the previous queued job's "
                "\"after\". 0 always takes a new one. The \"after\" snapshot is always new.",
    min=0, max=86400, restart_required=False,
)


@dataclass
class DrivePlan:
    """One drive's part in a recipe (JobRegistry.plan_batches): its steps, or
    why it is left out."""
    guid: str
    steps: list[PlannedStep] | None
    excluded: str | None


class JobRegistry:
    def __init__(
        self,
        max_parallel: int | None,
        get_context: Callable[[str], DriveContext | None],
        capture_smart: Callable[[str, float], dict | None] | None = None,
        is_locked: Callable[[str], bool | None] | None = None,
    ):
        self._max_parallel = max_parallel or None  # treat 0 the same as None/missing
        self._get_context = get_context
        # Whether a drive is locked against destructive operations
        # (DriveCollector.is_drive_locked). Checked again right before each
        # destructive run, since a drive can be locked while its job is queued.
        self._is_locked = is_locked
        # Returns a SMART snapshot summary for a drive, reusing a saved one up to
        # max_age seconds old (DriveCollector.capture_smart). Called just before
        # and just after each run; None disables snapshots.
        self._capture_smart = capture_smart
        self._jobs: dict[str, Job] = {}
        self._batches: dict[str, Batch] = {}  # this session's batches, and those of recovered jobs
        self._instances: dict[str, OperationBase] = {}
        self._pending: list[str] = []     # job ids in run order (FIFO unless moved)
        self._running: set[str] = set()   # drive guids with a job currently executing
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=_EXECUTOR_THREADS, thread_name_prefix="job")
        self._shutting_down = False

    @classmethod
    def from_config(
        cls,
        get_context: Callable[[str], DriveContext | None],
        capture_smart: Callable[[str, float], dict | None] | None = None,
        is_locked: Callable[[str], bool | None] | None = None,
    ) -> "JobRegistry":
        """Construct a JobRegistry from the registered jobs.max_parallel cfg value.

        restart_required — there's no live on_changed path, so reading it
        once here at startup is sufficient.
        """
        return cls(
            max_parallel=cfg.get("jobs.max_parallel"),
            get_context=get_context,
            capture_smart=capture_smart,
            is_locked=is_locked,
        )

    # ---------------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------------

    def create_jobs(self, guids: list[str], operation_key: str, params: dict) -> list[Job] | None:
        """Create one queued job per drive that supports the operation.

        Returns None if operation_key is unknown; raises ParamError if params
        don't fit the operation's ParamSpecs. Drives that are unknown or
        don't support the operation are silently skipped, so the returned
        list may be shorter than `guids` (or empty).
        """
        op_cls = OPERATIONS.get(operation_key)
        if op_cls is None:
            logger.debug("create_jobs: unknown operation '%s'", operation_key)
            return None

        # Raises ParamError before anything is queued: specs are the contract,
        # not just UI hints, since these values reach the command line.
        merged_params = validate_params(op_cls.params, params)

        created: list[Job] = []
        with self._lock:
            for guid in guids:
                context = self._get_context(guid)
                if context is None or not op_cls.supports(context):
                    continue
                job = Job(
                    id=str(uuid.uuid4()),
                    drive_guid=guid,
                    operation=operation_key,
                    category=op_cls.category,
                    params=dict(merged_params),
                )
                instance = op_cls()
                self._prepare_instance(instance, job)
                self._jobs[job.id] = job
                self._instances[job.id] = instance
                self._pending.append(job.id)
                job.queue_position = len(self._pending) - 1
                db.record_job(job)  # persist QUEUED state immediately
                created.append(job)
            self._dispatch()
        if created:
            logger.info("queued %d job(s) for operation '%s'", len(created), operation_key)
        else:
            logger.debug("create_jobs: no eligible drive(s) for operation '%s' among %s", operation_key, guids)
        return created

    def plan_batches(self, guids: list[str], recipe_key: str, params: dict) -> tuple[dict, list["DrivePlan"]] | None:
        """What starting a recipe on these drives would queue, without queueing
        anything: (the recipe's params merged onto its defaults, one DrivePlan
        per guid in order). Returns None if recipe_key is unknown; raises
        ParamError if params don't fit the recipe, RecipeError if its plan is
        invalid."""
        recipe_cls = RECIPES.get(recipe_key)
        if recipe_cls is None:
            logger.debug("plan_batches: unknown recipe '%s'", recipe_key)
            return None
        merged_params = validate_params(recipe_cls.params, params)
        recipe = recipe_cls()
        plans = []
        for guid in guids:
            context = self._get_context(guid)
            if context is None:
                plans.append(DrivePlan(guid, None, "Drive not found"))
                continue
            try:
                plans.append(DrivePlan(guid, plan_for_drive(recipe_key, recipe, context, merged_params, OPERATIONS), None))
            except DriveExcluded as e:
                plans.append(DrivePlan(guid, None, str(e)))
        return merged_params, plans

    def create_batches(
        self, guids: list[str], recipe_key: str, params: dict, stop_on_failure: bool | None = None,
    ) -> list[tuple[Batch, list[Job]]] | None:
        """Start a recipe: one Batch per drive, with every step's job queued up front.

        Returns None if recipe_key is unknown; raises ParamError if params don't
        fit the recipe's ParamSpecs, and RecipeError if the recipe's plan is
        invalid (a bug in the recipe — nothing is queued). stop_on_failure None
        takes the recipe's default. Drives plan_batches excludes get no batch,
        so the list may be shorter than `guids` (or empty). Steps the drive
        can't run that are marked "skip" are recorded as SKIPPED jobs, so each
        batch shows its plan in full.
        """
        # Plan every drive before queueing anything, so a bad plan leaves no
        # half-created batches behind.
        planned_batches = self.plan_batches(guids, recipe_key, params)
        if planned_batches is None:
            return None
        merged_params, drive_plans = planned_batches
        recipe_cls = RECIPES[recipe_key]
        stop = recipe_cls.stop_on_failure if stop_on_failure is None else bool(stop_on_failure)
        plans = [(p.guid, p.steps) for p in drive_plans if p.steps is not None]

        created: list[tuple[Batch, list[Job]]] = []
        with self._lock:
            for guid, planned in plans:
                batch = Batch(id=str(uuid.uuid4()), drive_guid=guid, recipe=recipe_key,
                              params=dict(merged_params), stop_on_failure=stop)
                db.record_batch(batch)
                self._batches[batch.id] = batch
                created.append((batch, [self._add_step(batch, index, planned_step)
                                        for index, planned_step in enumerate(planned)]))
            self._dispatch()
        if created:
            logger.info("recipe '%s' queued %d batch(es): %s", recipe_key, len(created),
                        ", ".join(f"{b.id[:8]} on {b.drive_guid} ({len(jobs)} steps)" for b, jobs in created))
        else:
            logger.debug("create_batches: no eligible drive(s) for recipe '%s' among %s", recipe_key, guids)
        return created

    def _add_step(self, batch: Batch, index: int, planned_step: PlannedStep) -> Job:
        """Create one step's job: queued, or SKIPPED if the drive can't run it.
        Caller holds self._lock."""
        step = planned_step.step
        job = Job(
            id=str(uuid.uuid4()),
            drive_guid=batch.drive_guid,
            operation=step.operation,
            category=planned_step.operation.category,
            params=planned_step.params,
            batch_id=batch.id,
            batch_step=index,
            step_check=step.check.to_dict() if step.check is not None else None,
        )
        self._jobs[job.id] = job
        if planned_step.supported:
            instance = planned_step.operation()
            self._prepare_instance(instance, job)
            self._instances[job.id] = instance
            self._pending.append(job.id)
            job.queue_position = len(self._pending) - 1
        else:
            job.status = JobStatus.SKIPPED
            job.finished_at = job.created_at
            job.error = "Not supported on this drive"
        db.record_job(job)
        return job

    def recover(self) -> None:
        """Restore QUEUED and RUNNING jobs from the previous process run.

        Must be called once at startup after collector.wait_for_scan() so that
        drive contexts are resolvable.  QUEUED jobs are re-enqueued normally;
        RUNNING jobs are submitted directly to _execute() with reattach_data so
        the operation can verify and resume its external resource (subprocess /
        SMART self-test).  Jobs that can't be recovered are marked INTERRUPTED.
        """
        rows = db.get_active_jobs()
        if not rows:
            return

        recovered_queued = 0
        recovered_running = 0
        interrupted: list[Job] = []

        batch_ids = sorted({row["batch_id"] for row in rows if row["batch_id"]})
        self._batches.update(db.get_batches(batch_ids))

        for row in rows:
            try:
                job = self._recover_one(row)
                if job.status == JobStatus.INTERRUPTED:
                    interrupted.append(job)
                elif job.status == JobStatus.QUEUED:
                    recovered_queued += 1
                else:
                    recovered_running += 1
            except Exception:
                logger.exception("unexpected error recovering job %s — marking interrupted", row["id"][:8])
                interrupted.append(self._mark_interrupted(row, "Unexpected error during recovery"))

        with self._lock:
            # Only now that every row is loaded: a batch's later steps may come
            # after its interrupted one.
            for job in interrupted:
                self._stop_chain_if_failed(job)
            self._renumber_queue()
            self._dispatch()

        logger.info(
            "job recovery: %d queued re-enqueued, %d running resumed, %d interrupted immediately",
            recovered_queued, recovered_running, len(interrupted),
        )

    def get_job(self, job_id: str) -> Job | None:
        """A job created this session, or None."""
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self) -> list[Job]:
        """Return a snapshot of all jobs created this session (queued, running, or finished)."""
        with self._lock:
            return list(self._jobs.values())

    def get_progress(self, job_id: str) -> OperationProgress | None:
        """Return the operation's current progress, or None if job_id is unknown.

        If the operation didn't supply its own eta_seconds, fill one in here
        by extrapolating from elapsed time (job.started_at) and percent —
        this is the one place that has both the Job and the operation
        instance, so it's the natural seam for that fallback rather than
        having Operation track its own start time or Job know about
        operation internals.
        """
        with self._lock:
            instance = self._instances.get(job_id)
            job = self._jobs.get(job_id)
        if instance is None:
            return None
        progress = instance.get_progress()
        if progress.eta_seconds is None and progress.percent is not None and job and job.started_at:
            if 0 < progress.percent < 100:
                elapsed = (clock.now() - job.started_at).total_seconds()
                estimated = elapsed * (100 - progress.percent) / progress.percent
                progress = replace(progress, eta_seconds=estimated)
        return progress

    def cancel_job(self, job_id: str) -> bool:
        """Cancel a queued or running job. Returns False if unknown or already finished."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                logger.debug("cancel_job: unknown job %s", job_id)
                return False
            if job.status == JobStatus.QUEUED:
                self._pending.remove(job_id)
                job.queue_position = None
                self._renumber_queue()
                job.status = JobStatus.CANCELLED
                job.finished_at = clock.now()
                logger.info("job %s cancelled while queued: %s", job.id[:8], job.operation)
                self._stop_chain_if_failed(job)
            elif job.status == JobStatus.RUNNING:
                self._instances[job_id].cancel()
                logger.info("job %s cancel requested: %s", job.id[:8], job.operation)
                return True
            else:
                logger.debug("cancel_job: job %s already finished (%s)", job.id[:8], job.status.value)
                return False
        db.record_job(job)
        return True

    def move_job(self, job_id: str, direction: int) -> bool | None:
        """Move a queued job one place earlier (direction -1) or later (+1)
        among its drive's queued jobs, passing a whole batch as one place.

        Returns None if job_id isn't a queued job, False if it is a batch step
        (move its batch instead) or already first or last, True once moved.
        Order across drives stays first-in, first-out: a job for an idle drive
        still starts ahead of jobs waiting on a busy one.
        """
        if direction not in (-1, 1):
            raise ValueError("direction must be -1 or 1")
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status != JobStatus.QUEUED:
                return None
            if job.batch_id is not None:
                return False
            moved = self._move_unit(job.drive_guid, lambda unit: unit == [job_id], direction)
        if moved:
            logger.info("job %s moved %s: %s", job_id[:8], "up" if direction < 0 else "down", job.operation)
        return moved

    def move_batch(self, batch_id: str, direction: int) -> bool | None:
        """Move a batch's queued steps, together, one place earlier (-1) or
        later (+1) among its drive's queued jobs, passing a whole batch as one
        place. Only a batch that hasn't started moves (see _move_unit).

        Returns None if batch_id isn't a batch with queued steps, False if it
        has started or is already first or last, True once moved.
        """
        if direction not in (-1, 1):
            raise ValueError("direction must be -1 or 1")
        with self._lock:
            batch = self._batches.get(batch_id)
            if batch is None:
                return None
            moved = self._move_unit(batch.drive_guid,
                                    lambda unit: self._jobs[unit[0]].batch_id == batch_id, direction)
        if moved:
            logger.info("batch %s moved %s", batch_id[:8], "up" if direction < 0 else "down")
        return moved

    def cancel_batch(self, batch_id: str) -> int | None:
        """Cancel a batch: its queued steps at once, its running one as it stops.
        Returns how many steps that cancels, or None if batch_id isn't a batch
        this session knows."""
        with self._lock:
            if batch_id not in self._batches:
                logger.debug("cancel_batch: unknown batch %s", batch_id)
                return None
            steps = [j for j in self._jobs.values() if j.batch_id == batch_id]
            queued = [j for j in steps if j.status == JobStatus.QUEUED]
            running = [j for j in steps if j.status == JobStatus.RUNNING]
            now = clock.now()
            for job in queued:
                self._pending.remove(job.id)
                job.queue_position = None
                job.status = JobStatus.CANCELLED
                job.finished_at = now
                db.record_job(job)
            if queued:
                self._renumber_queue()
            for job in running:
                self._instances[job.id].cancel()
        logger.info("batch %s cancelled: %d queued, %d running", batch_id[:8], len(queued), len(running))
        return len(queued) + len(running)

    def shutdown(self) -> None:
        """Allow any in-flight jobs to finish on their own, without blocking shutdown.

        Reattach data is already persisted at the moment each operation acquires
        its external resource — no flush needed here.  Subprocess-backed operations
        are intentionally left running so they can be reattached on the next startup.
        """
        logger.info("shutting down job registry (%d running)", len(self._running))
        self._shutting_down = True
        self._executor.shutdown(wait=False)

    # ---------------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------------

    def _snapshot(self, job: Job, when: str) -> dict | None:
        """Take a SMART snapshot for a job. Never raises: a failed capture is
        recorded as {"captured_at", "error"} so it can't fail the job itself."""
        if self._capture_smart is None:
            return None
        # "after" must reflect the run, so it is always new; "before" may reuse a
        # recent one (typically the previous queued job's "after").
        max_age = cfg.get("jobs.smart_snapshot_reuse_seconds") if when == "before" else 0
        try:
            snapshot = self._capture_smart(job.drive_guid, max_age)
        except Exception as e:
            logger.warning("job %s: SMART snapshot %s the run failed: %s", job.id[:8], when, e)
            return {"captured_at": clock.now_iso(), "error": str(e) or type(e).__name__}
        logger.debug("job %s: SMART snapshot %s the run: %s", job.id[:8], when,
                     "reused" if (snapshot or {}).get("reused") else "taken")
        return snapshot

    def _queue_units(self, guid: str) -> list[list[str]]:
        """A drive's queued job ids in run order, grouped into the units they
        move as: a standalone job alone, a batch's queued steps together.
        Caller holds self._lock."""
        units: list[list[str]] = []
        for jid in self._pending:
            job = self._jobs[jid]
            if job.drive_guid != guid:
                continue
            if job.batch_id is not None and units and self._jobs[units[-1][0]].batch_id == job.batch_id:
                units[-1].append(jid)
            else:
                units.append([jid])
        return units

    def _move_unit(self, guid: str, is_unit: Callable[[list[str]], bool], direction: int) -> bool | None:
        """Swap the drive's queue unit matching is_unit with its neighbour in
        `direction`. The drive's jobs keep the places in the run order they
        held, just refilled in the new order, so other drives' jobs don't move.
        A batch that has started keeps its remaining steps next on its drive, so
        nothing runs between them: that unit (always the drive's first, as
        units only move whole and new ones join at the end) can't be moved or
        passed.

        Returns None if no unit matches, False if there is no neighbour (or the
        unit is that started batch), True once moved. Caller holds self._lock."""
        units = self._queue_units(guid)
        index = next((k for k, unit in enumerate(units) if is_unit(unit)), None)
        if index is None:
            return None
        pinned = 1 if units and self._batch_started(self._jobs[units[0][0]].batch_id) else 0
        other = index + direction
        if index < pinned or not pinned <= other < len(units):
            return False
        units[index], units[other] = units[other], units[index]
        reordered = iter([jid for unit in units for jid in unit])
        self._pending = [next(reordered) if self._jobs[jid].drive_guid == guid else jid for jid in self._pending]
        self._renumber_queue()
        self._dispatch()
        return True

    def _batch_started(self, batch_id: str | None) -> bool:
        """Whether any step of the batch has started. Caller holds self._lock."""
        return batch_id is not None and any(
            j.batch_id == batch_id and j.started_at is not None for j in self._jobs.values()
        )

    def batch_started(self, batch_id: str) -> bool:
        """Whether any step of the batch has started (its remaining steps then
        stay next on the drive, and it can't be moved)."""
        with self._lock:
            return self._batch_started(batch_id)

    def _stop_chain_if_failed(self, job: Job) -> None:
        """If a batch step ended other than COMPLETED and its batch stops on
        failure, mark the batch's remaining queued steps SKIPPED. Caller holds
        self._lock, so none of them can be dispatched first. A batch whose row
        is missing counts as stopping on failure."""
        assert self._lock.locked(), "_stop_chain_if_failed called without holding self._lock"
        if job.batch_id is None or job.status in (JobStatus.COMPLETED, JobStatus.SKIPPED,
                                                  JobStatus.QUEUED, JobStatus.RUNNING):
            return
        batch = self._batches.get(job.batch_id)
        if batch is not None and not batch.stop_on_failure:
            return
        rest = [self._jobs[jid] for jid in self._pending if self._jobs[jid].batch_id == job.batch_id]
        if not rest:
            return
        op_cls = OPERATIONS.get(job.operation)
        step_name = op_cls.name if op_cls is not None else job.operation
        reason = f"Not run: step {job.batch_step + 1} ({step_name}) {job.status.value}"
        now = clock.now()
        for later in rest:
            self._pending.remove(later.id)
            later.queue_position = None
            later.status = JobStatus.SKIPPED
            later.finished_at = now
            later.error = reason
            db.record_job(later)
        self._renumber_queue()
        logger.info("batch %s: %d later step(s) skipped — %s", job.batch_id[:8], len(rest), reason)

    @staticmethod
    def _run_check(job: Job) -> str | None:
        """Evaluate a finished step's Check: None if it passes, else why not.
        A check that can't be rebuilt or raises fails the step — it was asked
        to vouch for the drive and couldn't."""
        try:
            return Check.from_dict(job.step_check).evaluate(job)
        except Exception as e:
            logger.warning("job %s: step check %r could not run: %s", job.id[:8], job.step_check, e)
            return f"Step check could not run: {e or type(e).__name__}"

    def _prepare_instance(self, instance: OperationBase, job: Job) -> None:
        """Wire job-id and the reattach-persist callback onto a fresh operation instance."""
        instance._job_id = job.id
        instance._save_reattach_cb = lambda: db.record_job(job, instance.get_reattach_data())

    def _dispatch(self) -> None:
        """Submit as many pending jobs as the concurrency limits allow. Caller holds self._lock.

        A single ordered pass gives both constraints: skip (don't break on) a
        job whose drive is already running something — a later job for a free
        drive can still start — and stop entirely once max_parallel jobs are
        running (if max_parallel is None, this never triggers — the per-drive
        check above already caps running jobs at the drive count).
        """
        assert self._lock.locked(), "_dispatch called without holding self._lock"
        for job_id in list(self._pending):
            job = self._jobs[job_id]
            if job.drive_guid in self._running:
                continue
            if self._max_parallel is not None and len(self._running) >= self._max_parallel:
                break
            self._submit(job)

    def _renumber_queue(self) -> None:
        """Give queued jobs positions 0..n-1 in run order, persisting any that
        changed. Caller holds self._lock."""
        assert self._lock.locked(), "_renumber_queue called without holding self._lock"
        changed = {}
        for pos, jid in enumerate(self._pending):
            job = self._jobs[jid]
            if job.queue_position != pos:
                job.queue_position = pos
                changed[jid] = pos
        db.set_queue_positions(changed)

    def _submit(self, job: Job, reattach_data: dict | None = None) -> None:
        """Mark a job as running and submit it to the executor. Caller holds self._lock."""
        assert self._lock.locked(), "_submit called without holding self._lock"
        if job.id in self._pending:
            self._pending.remove(job.id)
            job.queue_position = None
            self._renumber_queue()
        self._running.add(job.drive_guid)
        if reattach_data is None:
            # Fresh dispatch — set started_at now
            job.status = JobStatus.RUNNING
            job.started_at = clock.now()
            db.record_job(job, self._instances[job.id].get_reattach_data())
        # For recovered RUNNING jobs, status/started_at are already correct from the DB row
        self._executor.submit(self._execute, job, reattach_data)

    def _execute(self, job: Job, reattach_data: dict | None = None) -> None:
        logger.info("job %s %s: %s", job.id[:8], "reattaching" if reattach_data is not None else "started", job.operation)
        instance = self._instances[job.id]
        context = self._get_context(job.drive_guid)
        started = False
        completed = False
        try:
            if context is None:
                raise RuntimeError("drive no longer present")
            # Not on reattach: that job is already running on the drive.
            if (reattach_data is None and instance.destructive
                    and self._is_locked is not None and self._is_locked(job.drive_guid)):
                raise RuntimeError("drive was locked while this job was queued — unlock it to run this operation")
            started = True
            if reattach_data is None and job.smart_before is None:
                # Not on reattach: the snapshot from before the restart is already saved.
                job.smart_before = self._snapshot(job, "before")
                db.record_job(job, instance.get_reattach_data())
            if reattach_data is not None:
                job.result = instance.reattach(context, job.params, reattach_data)
            else:
                job.result = instance.run(context, job.params)
            completed = True
            if job.step_check is None:
                job.status = JobStatus.COMPLETED
                logger.info("job %s completed: %s", job.id[:8], job.operation)
            # else: stays RUNNING until its check (below) decides the outcome
        except OperationCancelled:
            job.status = JobStatus.CANCELLED
            logger.info("job %s cancelled: %s", job.id[:8], job.operation)
        except (NotImplementedError, ReattachFailed) as e:
            job.status = JobStatus.INTERRUPTED
            job.error = str(e) if str(e) else "Could not resume after restart"
            logger.warning("job %s interrupted: %s — %s", job.id[:8], job.operation, job.error)
        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
            logger.warning("job %s failed: %s — %s", job.id[:8], job.operation, e)
        job.finished_at = clock.now()
        if (summary := instance.get_summary_log()) is not None:
            job.summary_log = job_logs.limit_summary(summary, job.id)
        if started and not self._shutting_down:
            job.smart_after = self._snapshot(job, "after")
        # While shutting down there's no "after" snapshot to judge and nothing
        # is saved: the row stays RUNNING, so the next start resumes the step
        # (or interrupts it) and its check runs then.
        if completed and job.step_check is not None and not self._shutting_down:
            if (reason := self._run_check(job)) is not None:
                job.status = JobStatus.FAILED
                job.error = reason
                logger.warning("job %s failed its step check: %s — %s", job.id[:8], job.operation, reason)
            else:
                job.status = JobStatus.COMPLETED
                logger.info("job %s completed and passed its step check: %s", job.id[:8], job.operation)

        with self._lock:
            self._running.discard(job.drive_guid)
            if not self._shutting_down:
                self._stop_chain_if_failed(job)
                self._dispatch()
        if not self._shutting_down:
            db.record_job(job)

    def _recover_one(self, row) -> Job:
        """Recover a single active job row from the previous run. Returns the
        job: re-enqueued, submitted for reattach, or marked INTERRUPTED."""
        job_id = row["id"]

        op_cls = OPERATIONS.get(row["operation"])
        if op_cls is None:
            logger.warning("job %s: operation '%s' no longer available — marking interrupted", job_id[:8], row["operation"])
            return self._mark_interrupted(row, f"Operation '{row['operation']}' is no longer available")

        context = self._get_context(row["drive_guid"])
        if context is None:
            logger.warning("job %s: drive %s not present after restart — marking interrupted", job_id[:8], row["drive_guid"])
            return self._mark_interrupted(row, "Drive not present after restart")

        job = _job_from_row(row)
        instance = op_cls()
        self._prepare_instance(instance, job)

        with self._lock:
            self._jobs[job.id] = job
            self._instances[job.id] = instance

            if job.status == JobStatus.QUEUED:
                self._pending.append(job.id)
                logger.info("job %s re-enqueued: %s", job.id[:8], job.operation)

            elif job.status == JobStatus.RUNNING:
                reattach_data = json.loads(row["reattach_json"]) if row["reattach_json"] else {}
                # Occupy the drive slot unconditionally — already-running jobs are not
                # subject to the current max_parallel cap (a shrunk cap should never
                # preempt a job that was already in flight).
                self._running.add(job.drive_guid)
                self._executor.submit(self._execute, job, reattach_data)
                logger.info("job %s submitted for reattach: %s", job.id[:8], job.operation)
        return job

    @staticmethod
    def _mark_interrupted(row, error_message: str) -> Job:
        """Write an INTERRUPTED terminal record for a job that can't be resumed."""
        job = _job_from_row(row)
        job.status = JobStatus.INTERRUPTED
        job.error = error_message
        job.finished_at = clock.now()
        job.queue_position = None
        db.record_job(job)
        return job


def _job_from_row(row) -> Job:
    """The Job an active jobs row describes (as restart recovery needs it)."""
    return Job(
        id=row["id"],
        drive_guid=row["drive_guid"],
        operation=row["operation"],
        category=row["category"],
        params=json.loads(row["params_json"]),
        status=JobStatus(row["status"]),
        created_at=clock.parse(row["created_at"]),
        started_at=clock.parse(row["started_at"]) if row["started_at"] else None,
        smart_before=_json_or_none(row["smart_before_json"]),
        batch_id=row["batch_id"],
        batch_step=row["batch_step"],
        step_check=_json_or_none(row["step_check_json"]),
    )
