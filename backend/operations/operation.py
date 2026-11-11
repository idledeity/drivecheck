"""
operations.operation — Operation interface for the Jobs system.

Operations are user-initiated tasks performed on a drive (SMART tests,
read scans, etc.), distinct from the passive collector probes. Each
operation is a class registered in operations.operation_registry.OPERATIONS; a Job
holds one instance of that class for the duration of its run.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable

from drives.drive_models import DriveContext


def format_bytes(n: int) -> str:
    """Decimal byte size as drive vendors (and dd) report it, e.g. 6.0 TB."""
    if n < 1000:
        return f"{n} B"
    # Choose the unit by the rounded value, so 999_999_999_999 is 1.0 TB and
    # not 1000.0 GB.
    for unit, size in (("KB", 1e3), ("MB", 1e6), ("GB", 1e9)):
        if round(n / size, 1) < 1000:
            return f"{n / size:.1f} {unit}"
    return f"{n / 1e12:.1f} TB"


class OperationCancelled(Exception):
    """Raised by an operation's run() when cancellation is requested mid-execution."""


class ReattachFailed(Exception):
    """Raised by reattach() when verification of a previously-RUNNING job fails.

    Distinct from NotImplementedError (operation type never supports reattach)
    — both land the job in INTERRUPTED but with different messages.
    """


@dataclass
class ParamSpec:
    """Describes one configurable parameter for the Run Task form.

    Also the server-side contract (validate_params): "number" means an integer
    (every one is a count, size or duration that ends up on a command line),
    and min/max are enforced, not just hints for the form.
    """
    name: str
    label: str
    type: str   # "number" | "string" | "boolean"
    default: object
    min: float | None = None
    max: float | None = None
    tooltip: str | None = None  # longer explanation, shown on hover in the Run Task form


class ParamError(ValueError):
    """A job param failed validation against its operation's ParamSpecs."""

    def __init__(self, field: str, message: str):
        super().__init__(f"{field}: {message}")
        self.field = field
        self.message = message


def validate_params(specs: list[ParamSpec], params: dict) -> dict:
    """Return params merged onto the specs' defaults, checked and coerced.

    Raises ParamError for an unknown key, a value of the wrong type, or a
    number outside min/max. Integral floats (4096.0) are accepted as ints;
    booleans are never accepted as numbers.
    """
    by_name = {s.name: s for s in specs}
    unknown = sorted(set(params) - set(by_name))
    if unknown:
        raise ParamError(unknown[0], "unknown parameter")

    merged: dict = {}
    for spec in specs:
        value = params.get(spec.name, spec.default)
        if spec.type == "boolean":
            if not isinstance(value, bool):
                raise ParamError(spec.name, "must be true or false")
        elif spec.type == "number":
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ParamError(spec.name, "must be a whole number")
            if spec.min is not None and value < spec.min:
                raise ParamError(spec.name, f"must be at least {spec.min:g}")
            if spec.max is not None and value > spec.max:
                raise ParamError(spec.name, f"must be at most {spec.max:g}")
        elif spec.type == "string":
            if not isinstance(value, str):
                raise ParamError(spec.name, "must be text")
        merged[spec.name] = value
    return merged


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
    category: str        # "Test" | "Scan" | "Maintenance" | "Debug"
    tool: str
    params: list[ParamSpec] = []
    destructive: bool = False   # True if the operation writes to or erases the drive
    # Keys this operation was registered under before (its module was renamed
    # or merged). Job rows store the key, so lookups of these still resolve to
    # it; listings only show the current key.
    former_keys: tuple[str, ...] = ()

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

    @classmethod
    def summarize(cls, result: dict) -> str | None:
        """One-line, human-readable outcome of a completed run, from its result
        dict — the "Result" shown for every job, whatever the operation.
        Classmethod so stored results of past jobs can be summarized too.
        Default: none (the UI falls back to the job status)."""
        return None

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

    # ------------------------------------------------------------------
    # Restart-reattachment interface
    # ------------------------------------------------------------------

    def get_reattach_data(self) -> dict | None:
        """Return the data needed to reattach to this operation after a restart.

        Called immediately after the operation has acquired its external resource
        (spawned a subprocess, or confirmed a self-test started on the drive).
        Return None until that moment — JobRegistry will persist the first
        non-None value it receives.  Default: None (operation is not reattachable).
        """
        return None

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        """Resume a job that was RUNNING when the process last stopped.

        Same return/exception contract as run(): return a JSON-serialisable result
        dict on success, raise OperationCancelled if cancelled mid-run, or raise
        any other exception to mark the job FAILED.  Raise ReattachFailed (not
        RuntimeError) when the external resource can't be verified — that produces
        INTERRUPTED rather than FAILED.  Default: unsupported.
        """
        raise NotImplementedError("operation does not support reattach")

    def _save_reattach(self) -> None:
        """Call after acquiring the reattachable external resource to persist
        reattach data immediately.  No-op unless JobRegistry has wired a callback
        onto this instance via _save_reattach_cb."""
        cb: Callable[[], None] | None = getattr(self, "_save_reattach_cb", None)
        if cb is not None:
            cb()
