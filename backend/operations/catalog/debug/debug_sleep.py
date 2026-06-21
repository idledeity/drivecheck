"""
operations.catalog.debug.debug_sleep — Fake operation for exercising the job queue/scheduler.

Sleeps for a configurable duration, reporting progress along the way.
Loaded only if config.yaml: jobs.enable_debug_operations is true.
"""

import logging
import threading

from operations.operation import OperationBase, OperationCancelled, ParamSpec
from drives.drive_models import DriveContext

logger = logging.getLogger(__name__)

_STEP_SECONDS = 0.25


class DebugSleepOperation(OperationBase):
    name = "Sleep (debug)"
    category = "Debug"
    tool = "none"
    params = [
        ParamSpec(name="duration", label="Duration (seconds)", type="number", default=10, min=1, max=120),
        ParamSpec(name="fail", label="Fail partway through", type="boolean", default=False),
    ]

    def __init__(self):
        self._cancel_event = threading.Event()
        self._percent: int | None = 0
        self._message: str | None = "Queued"
        self._remaining: float | None = None

    @staticmethod
    def supports(_context: DriveContext) -> bool:
        return True

    def run(self, _context: DriveContext, params: dict) -> dict:
        duration = float(params["duration"])
        fail = bool(params["fail"])
        elapsed = 0.0
        self._remaining = duration
        self._message = f"Sleeping ({duration:.0f}s)"
        logger.debug("debug sleep starting: duration=%.0fs fail=%s", duration, fail)
        while elapsed < duration:
            if self._cancel_event.wait(min(_STEP_SECONDS, duration - elapsed)):
                self._message = "Cancelled"
                raise OperationCancelled()
            elapsed += _STEP_SECONDS
            self._percent = min(100, int(elapsed / duration * 100))
            self._remaining = max(0.0, duration - elapsed)
            if fail and elapsed >= duration / 2:
                self._message = "Failed (forced)"
                raise RuntimeError("forced failure (params.fail=true)")
        self._percent = 100
        self._remaining = 0.0
        self._message = "Done"
        return {"slept_seconds": duration}

    def get_percent(self) -> float | None:
        return self._percent

    def get_message(self) -> str | None:
        return self._message

    def get_eta_seconds(self) -> float | None:
        return self._remaining

    def cancel(self) -> None:
        self._cancel_event.set()
