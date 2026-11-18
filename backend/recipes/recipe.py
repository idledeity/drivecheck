"""
recipes.recipe — Recipe interface for batch jobs.

A recipe is a named sequence of operations run one after another on a drive
— e.g. "Initial scan" = short, conveyance, long self-tests. Starting one gives
each selected drive its own Batch (jobs.job_models) with every step's Job
created up front, so the whole plan shows in the queue with its settings fixed.

A recipe declares its own inputs (ParamSpecs, rendered by the Run Task form
like an operation's) and maps them to each step's operation params per drive
in plan() — the place to "do the right thing" for that drive (pick a block
size from its capacity, leave out a test it can't run). Users never set a
step's raw params directly.

A step may carry a Check: evaluated once the step's job ends COMPLETED (with
its before/after SMART snapshots taken), it can fail the step with a reason.
Checks only ever stop — they can't add or change steps. They are plain data
(to_dict / Check.from_dict), persisted with the step's job, so they still
apply to a step that resumes after a restart.
"""

import logging
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, ClassVar, Literal

from drives.drive_models import DriveContext
from operations.operation import OperationBase, ParamError, ParamSpec, validate_params

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from jobs.job_models import Job


class Check(ABC):
    """A pass/fail condition on a finished step. Subclasses set a unique `kind`
    and are registered automatically, so a stored check can be rebuilt."""

    kind: ClassVar[str]
    _kinds: ClassVar[dict[str, type["Check"]]] = {}

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not getattr(cls, "__abstractmethods__", None):
            if cls.kind in Check._kinds and Check._kinds[cls.kind] is not cls:
                raise ValueError(f"check kind '{cls.kind}' is already registered")
            Check._kinds[cls.kind] = cls

    @abstractmethod
    def evaluate(self, job: "Job") -> str | None:
        """Return None if the step passes, else why it failed (shown as the job's error)."""

    @abstractmethod
    def args(self) -> dict:
        """JSON-serialisable constructor kwargs, so the check can be rebuilt by from_dict."""

    def to_dict(self) -> dict:
        return {"kind": self.kind, **self.args()}

    @staticmethod
    def from_dict(data: dict) -> "Check":
        """Rebuild a stored check. Raises KeyError for an unknown kind."""
        args = dict(data)
        kind = args.pop("kind")
        return Check._kinds[kind](**args)


@dataclass
class Step:
    """One operation in a recipe's plan for a single drive.

    params: the operation's params (validated against its ParamSpecs when the
    batch is created). if_unsupported: what to do when the operation doesn't
    support the drive — "skip" records the step as skipped and carries on,
    "fail" leaves the drive out of the batch entirely.
    """
    operation: str
    params: dict = field(default_factory=dict)
    check: Check | None = None
    if_unsupported: Literal["skip", "fail"] = "fail"


class Recipe(ABC):
    """Base class for recipes. Discovered from recipes/catalog/, keyed by module name."""

    name: str
    description: str
    params: list[ParamSpec] = []
    # Default for the Run Task form's "stop on failure" option: whether a step
    # that doesn't complete (or fails its check) skips the drive's remaining steps.
    stop_on_failure: bool = True
    # True if any step can write to or erase the drive. Must cover every step
    # plan() can return — create_batch refuses a plan that breaks it — so the
    # UI can ask for a destructive confirmation before a plan exists.
    destructive: bool = False

    @classmethod
    def supports(cls, context: DriveContext) -> bool:
        """Return True if this recipe can run on the drive. Default: True —
        steps the drive can't run are handled by each Step's if_unsupported."""
        return True

    @abstractmethod
    def plan(self, context: DriveContext, params: dict) -> list[Step]:
        """The steps to run on this drive, in order, given the recipe's
        validated params (merged onto its ParamSpecs' defaults)."""


class RecipeError(Exception):
    """A recipe produced an invalid plan (unknown operation, params that don't
    fit it, an undeclared destructive step) — a bug in the recipe, not the request."""


@dataclass
class PlannedStep:
    """A Step checked against its operation for one drive."""
    step: Step
    operation: type[OperationBase]
    params: dict      # the step's params, validated and merged onto the operation's defaults
    supported: bool   # False only for a step marked if_unsupported="skip"


def plan_for_drive(
    recipe_key: str,
    recipe: Recipe,
    context: DriveContext,
    params: dict,
    operations: Mapping[str, type[OperationBase]],
) -> list[PlannedStep] | None:
    """A recipe's plan for one drive, each step checked against its operation.

    params are the recipe's validated params; operations is the operation
    registry to resolve steps against. Returns None if the drive can't take
    part: a step it can't run is marked if_unsupported="fail", or no step is
    left that it can run. Raises RecipeError for a plan the recipe should
    never produce (unknown operation, params that don't fit it, a destructive
    step in a recipe not marked destructive).
    """
    planned = []
    for index, step in enumerate(recipe.plan(context, params)):
        where = f"recipe '{recipe_key}' step {index + 1} ({step.operation})"
        op_cls = operations.get(step.operation)
        if op_cls is None:
            raise RecipeError(f"{where}: unknown operation")
        if op_cls.destructive and not recipe.destructive:
            raise RecipeError(f"{where}: the operation is destructive but the recipe isn't marked destructive")
        try:
            step_params = validate_params(op_cls.params, step.params)
        except ParamError as e:
            raise RecipeError(f"{where}: {e}") from e
        supported = op_cls.supports(context)
        if not supported and step.if_unsupported == "fail":
            logger.debug("%s: drive %s can't run it — left out", where, context.guid)
            return None
        planned.append(PlannedStep(step, op_cls, dict(step_params), supported))
    if not any(p.supported for p in planned):
        return None
    return planned
