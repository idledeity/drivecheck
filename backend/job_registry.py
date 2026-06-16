"""
job_registry.py — In-memory job queue + scheduler for the Operations/Jobs system.

Jobs are created against one or more drives and run via operation instances
from operations.registry.OPERATIONS. Dispatch enforces two constraints:
  - at most `max_parallel` jobs running at once, across all drives (if
    max_parallel is None, this constraint is a no-op -- see _dispatch)
  - at most one running job per drive

Dispatch is event-driven — triggered on job creation and again when a job
finishes (freeing its drive and/or a worker slot) — so no separate scheduler
thread is needed.

Active job state lives in memory only (server restart mid-job loses the job —
acceptable, the user re-runs it). Terminal jobs (completed/failed/cancelled)
are additionally persisted to the `jobs` table via db.record_job() for future
History tab use.
"""

import logging
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import db

logger = logging.getLogger(__name__)
from operations.operation import OperationBase, OperationCancelled, OperationProgress
from operations.registry import OPERATIONS
from drive_models import DriveContext
from job_models import Job, JobStatus


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

    def create_jobs(self, guids: list[str], operation_key: str, params: dict) -> list[Job] | None:
        """Create one queued job per drive that supports the operation.

        Returns None if operation_key is unknown. Drives that are unknown or
        don't support the operation are silently skipped, so the returned
        list may be shorter than `guids` (or empty).
        """
        op_cls = OPERATIONS.get(operation_key)
        if op_cls is None:
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
                self._jobs[job.id] = job
                self._instances[job.id] = op_cls()
                self._pending.append(job.id)
                created.append(job)
            self._dispatch()
        if created:
            logger.info("queued %d job(s) for operation '%s'", len(created), operation_key)
        return created

    def list_jobs(self) -> list[Job]:
        """Return a snapshot of all jobs created this session (queued, running, or finished)."""
        with self._lock:
            return list(self._jobs.values())

    def get_progress(self, job_id: str) -> OperationProgress | None:
        """Return the operation's current progress, or None if job_id is unknown."""
        with self._lock:
            instance = self._instances.get(job_id)
        return instance.get_progress() if instance else None

    def cancel_job(self, job_id: str) -> bool:
        """Cancel a queued or running job. Returns False if unknown or already finished."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if job.status == JobStatus.QUEUED:
                self._pending.remove(job_id)
                job.status = JobStatus.CANCELLED
                job.finished_at = datetime.now()
            elif job.status == JobStatus.RUNNING:
                self._instances[job_id].cancel()
                return True
            else:
                return False
        db.record_job(job)
        return True

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
            self._pending.remove(job_id)
            self._running.add(job.drive_guid)
            job.status = JobStatus.RUNNING
            job.started_at = datetime.now()
            self._executor.submit(self._execute, job)

    def _execute(self, job: Job) -> None:
        logger.info("job %s started: %s", job.id[:8], job.operation)
        instance = self._instances[job.id]
        context = self._get_context(job.drive_guid)
        try:
            if context is None:
                raise RuntimeError("drive no longer present")
            job.result = instance.run(context, job.params)
            job.status = JobStatus.COMPLETED
            logger.info("job %s completed: %s", job.id[:8], job.operation)
        except OperationCancelled:
            job.status = JobStatus.CANCELLED
            logger.info("job %s cancelled: %s", job.id[:8], job.operation)
        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
            logger.warning("job %s failed: %s — %s", job.id[:8], job.operation, e)
        job.finished_at = datetime.now()

        with self._lock:
            self._running.discard(job.drive_guid)
            self._dispatch()
        db.record_job(job)

    def shutdown(self) -> None:
        """Allow any in-flight jobs to finish on their own, without blocking shutdown."""
        self._executor.shutdown(wait=False)
