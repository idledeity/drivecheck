"""
operations.operation — Operation interface for the Jobs system.

Operations are user-initiated tasks performed on a drive (SMART tests,
read scans, etc.), distinct from the passive collector probes. Each
operation is a class registered in operations.registry.OPERATIONS; a Job
holds one instance of that class for the duration of its run.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass

from drive_models import DriveContext


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
    """Progress snapshot reported by a running operation."""
    percent: float | None = None
    message: str | None = None


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
        """Return current progress. Default: no progress info."""
        return OperationProgress()

    def cancel(self) -> None:
        """Request cancellation of a running operation. Default: no-op."""
