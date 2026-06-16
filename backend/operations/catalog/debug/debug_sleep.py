"""
operations.catalog.debug.debug_sleep — Fake operation for exercising the job queue/scheduler.

Sleeps for a configurable duration, reporting progress along the way.
Loaded only if config.yaml: jobs.enable_debug_operations is true.
"""

import threading

from operations.operation import OperationBase, OperationCancelled, OperationProgress, ParamSpec
from drive_models import DriveContext

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

    @staticmethod
    def supports(_context: DriveContext) -> bool:
        return True

    def run(self, _context: DriveContext, params: dict) -> dict:
        duration = float(params["duration"])
        fail = bool(params["fail"])
        elapsed = 0.0
        self._message = f"Sleeping ({duration:.0f}s)"
        while elapsed < duration:
            if self._cancel_event.wait(min(_STEP_SECONDS, duration - elapsed)):
                self._message = "Cancelled"
                raise OperationCancelled()
            elapsed += _STEP_SECONDS
            self._percent = min(100, int(elapsed / duration * 100))
            if fail and elapsed >= duration / 2:
                self._message = "Failed (forced)"
                raise RuntimeError("forced failure (params.fail=true)")
        self._percent = 100
        self._message = "Done"
        return {"slept_seconds": duration}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
