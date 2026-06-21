"""
operations.operation — Operation interface for the Jobs system.

Operations are user-initiated tasks performed on a drive (SMART tests,
read scans, etc.), distinct from the passive collector probes. Each
operation is a class registered in operations.operation_registry.OPERATIONS; a Job
holds one instance of that class for the duration of its run.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass

from drives.drive_models import DriveContext


class OperationCancelled(Exception):
    """Raised by an operation's run() when cancellation is requested mid-execution."""


@dataclass
class ParamSpec:
    """Describes one configurable parameter for the Run Task form."""
    name: str
    label: str
    type: str   # "number" | "string" | "boolean"
    default: object
    min: float | None = None
    max: float | None = None


@dataclass
class OperationProgress:
    """Progress snapshot reported by a running operation.

    eta_seconds is an operation-provided estimate of remaining time, used
    when the operation actually knows its own pacing (e.g. a fixed total
    duration). Left None for operations that can't estimate it themselves —
    JobRegistry.get_progress() then falls back to extrapolating from elapsed
    time (job.started_at) and percent, if percent is available.
    """
    percent: float | None = None
    message: str | None = None
    eta_seconds: float | None = None


class OperationBase(ABC):
    """Base class for all operations. Subclasses are registered, not instantiated, at startup."""

    name: str
    category: str   # "Test" | "Scan" | "Maintenance" | "Debug"
    tool: str
    params: list[ParamSpec] = []

    @staticmethod
    @abstractmethod
    def supports(context: DriveContext) -> bool:
        """Return True if this operation can run against the given drive."""

    @abstractmethod
    def run(self, context: DriveContext, params: dict) -> dict:
        """Execute the operation, returning a JSON-serializable result dict.

        Raise OperationCancelled if cancel() was called mid-run; any other
        exception marks the job as failed with str(exception) as the error.
        """

    def get_progress(self) -> OperationProgress:
        """Return current progress, assembled from get_percent()/get_message()/
        get_eta_seconds() below. Operations whose percent and message are
        derived together from one piece of state (e.g. parsing one smartctl
        call) can override this directly instead of the three hooks."""
        return OperationProgress(
            percent=self.get_percent(),
            message=self.get_message(),
            eta_seconds=self.get_eta_seconds(),
        )

    def get_percent(self) -> float | None:
        """0-100 completion estimate, or None if indeterminate. Default: no estimate."""
        return None

    def get_message(self) -> str | None:
        """Short human-readable status (e.g. "Sleeping (10s)"). Default: none."""
        return None

    def get_eta_seconds(self) -> float | None:
        """Operation's own estimate of remaining time, if it actually knows its
        pacing (e.g. a fixed total duration). Default: None — let
        JobRegistry.get_progress() fall back to extrapolating from elapsed
        time and get_percent()."""
        return None

    def cancel(self) -> None:
        """Request cancellation of a running operation. Default: no-op."""
