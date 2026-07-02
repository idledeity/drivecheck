"""
job_registry.py — In-memory job queue + scheduler for the Operations/Jobs system.

Jobs are created against one or more drives and run via operation instances
from operations.operation_registry.OPERATIONS. Dispatch enforces two constraints:
  - at most `max_parallel` jobs running at once, across all drives (if
    max_parallel is None, this constraint is a no-op -- see _dispatch)
  - at most one running job per drive

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
from dataclasses import replace
from datetime import datetime

from settings import cfg
from database import db

logger = logging.getLogger(__name__)
from operations.operation import OperationBase, OperationCancelled, OperationProgress, ReattachFailed
from operations.operation_registry import OPERATIONS
from drives.drive_models import DriveContext
from jobs.job_models import Job, JobStatus


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

cfg.register("jobs.max_parallel",
    default=2, type="int", label="Max parallel jobs",
    section="Jobs", description="Cap on simultaneously-running jobs across all drives.",
    min=1, max=8, restart_required=True,
)


class JobRegistry:
    def __init__(self, max_parallel: int | None, get_context: Callable[[str], DriveContext | None]):
        self._max_parallel = max_parallel or None  # treat 0 the same as None/missing
        self._get_context = get_context
        self._jobs: dict[str, Job] = {}
        self._instances: dict[str, OperationBase] = {}
        self._pending: list[str] = []     # job ids, FIFO
        self._running: set[str] = set()   # drive guids with a job currently executing
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=self._max_parallel, thread_name_prefix="job")
        self._shutting_down = False

    @classmethod
    def from_config(cls, get_context: Callable[[str], DriveContext | None]) -> "JobRegistry":
        """Construct a JobRegistry from the registered jobs.max_parallel cfg value.

        restart_required — there's no live on_changed path, so reading it
        once here at startup is sufficient.
        """
        return cls(max_parallel=cfg.get("jobs.max_parallel"), get_context=get_context)

    # ---------------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------------

    def create_jobs(self, guids: list[str], operation_key: str, params: dict) -> list[Job] | None:
        """Create one queued job per drive that supports the operation.

        Returns None if operation_key is unknown. Drives that are unknown or
        don't support the operation are silently skipped, so the returned
        list may be shorter than `guids` (or empty).
        """
        op_cls = OPERATIONS.get(operation_key)
        if op_cls is None:
            logger.debug("create_jobs: unknown operation '%s'", operation_key)
            return None

        merged_params = {p.name: p.default for p in op_cls.params}
        merged_params.update(params)

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
                db.record_job(job)  # persist QUEUED state immediately
                created.append(job)
            self._dispatch()
        if created:
            logger.info("queued %d job(s) for operation '%s'", len(created), operation_key)
        else:
            logger.debug("create_jobs: no eligible drive(s) for operation '%s' among %s", operation_key, guids)
        return created

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
        interrupted_immediately = 0

        for row in rows:
            try:
                self._recover_one(row)
                if row["status"] == JobStatus.QUEUED.value:
                    recovered_queued += 1
                else:
                    recovered_running += 1
            except Exception:
                logger.exception("unexpected error recovering job %s — marking interrupted", row["id"][:8])
                self._mark_interrupted_by_id(
                    row["id"], row["drive_guid"], row["operation"],
                    row["category"], row["params_json"],
                    row["created_at"], row["started_at"],
                    "Unexpected error during recovery",
                )
                interrupted_immediately += 1

        with self._lock:
            self._dispatch()

        logger.info(
            "job recovery: %d queued re-enqueued, %d running resumed, %d interrupted immediately",
            recovered_queued, recovered_running, interrupted_immediately,
        )

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
                elapsed = (datetime.now() - job.started_at).total_seconds()
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
                job.status = JobStatus.CANCELLED
                job.finished_at = datetime.now()
                logger.info("job %s cancelled while queued: %s", job.id[:8], job.operation)
            elif job.status == JobStatus.RUNNING:
                self._instances[job_id].cancel()
                logger.info("job %s cancel requested: %s", job.id[:8], job.operation)
                return True
            else:
                logger.debug("cancel_job: job %s already finished (%s)", job.id[:8], job.status.value)
                return False
        db.record_job(job)
        return True

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

    def _submit(self, job: Job, reattach_data: dict | None = None) -> None:
        """Mark a job as running and submit it to the executor. Caller holds self._lock."""
        assert self._lock.locked(), "_submit called without holding self._lock"
        if job.id in self._pending:
            self._pending.remove(job.id)
        self._running.add(job.drive_guid)
        if reattach_data is None:
            # Fresh dispatch — set started_at now
            job.status = JobStatus.RUNNING
            job.started_at = datetime.now()
            db.record_job(job, self._instances[job.id].get_reattach_data())
        # For recovered RUNNING jobs, status/started_at are already correct from the DB row
        self._executor.submit(self._execute, job, reattach_data)

    def _execute(self, job: Job, reattach_data: dict | None = None) -> None:
        logger.info("job %s %s: %s", job.id[:8], "reattaching" if reattach_data is not None else "started", job.operation)
        instance = self._instances[job.id]
        context = self._get_context(job.drive_guid)
        try:
            if context is None:
                raise RuntimeError("drive no longer present")
            if reattach_data is not None:
                job.result = instance.reattach(context, job.params, reattach_data)
            else:
                job.result = instance.run(context, job.params)
            job.status = JobStatus.COMPLETED
            logger.info("job %s completed: %s", job.id[:8], job.operation)
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
        job.finished_at = datetime.now()

        with self._lock:
            self._running.discard(job.drive_guid)
            if not self._shutting_down:
                self._dispatch()
        if not self._shutting_down:
            db.record_job(job)

    def _recover_one(self, row) -> None:
        """Attempt to recover a single active job row from the previous run."""
        job_id = row["id"]

        op_cls = OPERATIONS.get(row["operation"])
        if op_cls is None:
            logger.warning("job %s: operation '%s' no longer available — marking interrupted", job_id[:8], row["operation"])
            self._mark_interrupted_by_id(
                job_id, row["drive_guid"], row["operation"],
                row["category"], row["params_json"],
                row["created_at"], row["started_at"],
                f"Operation '{row['operation']}' is no longer available",
            )
            return

        context = self._get_context(row["drive_guid"])
        if context is None:
            logger.warning("job %s: drive %s not present after restart — marking interrupted", job_id[:8], row["drive_guid"])
            self._mark_interrupted_by_id(
                job_id, row["drive_guid"], row["operation"],
                row["category"], row["params_json"],
                row["created_at"], row["started_at"],
                "Drive not present after restart",
            )
            return

        job = Job(
            id=job_id,
            drive_guid=row["drive_guid"],
            operation=row["operation"],
            category=row["category"],
            params=json.loads(row["params_json"]),
            status=JobStatus(row["status"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            started_at=datetime.fromisoformat(row["started_at"]) if row["started_at"] else None,
        )

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

    def _mark_interrupted_by_id(
        self,
        job_id: str,
        drive_guid: str,
        operation: str,
        category: str,
        params_json: str,
        created_at_iso: str,
        started_at_iso: str | None,
        error_message: str,
    ) -> None:
        """Write an INTERRUPTED terminal record for a job that can't be reconstructed."""
        job = Job(
            id=job_id,
            drive_guid=drive_guid,
            operation=operation,
            category=category,
            params=json.loads(params_json),
            status=JobStatus.INTERRUPTED,
            error=error_message,
            created_at=datetime.fromisoformat(created_at_iso),
            started_at=datetime.fromisoformat(started_at_iso) if started_at_iso else None,
            finished_at=datetime.now(),
        )
        db.record_job(job)
