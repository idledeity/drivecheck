"""
recipes.catalog.debug — debug recipes: quick batches of Sleep (debug) steps
that touch no drive, for exercising the batch UI without waiting days.
Loaded only if config.yaml: jobs.enable_debug_operations is true (they need
the debug Sleep operation).
"""

from drives.drive_models import DriveContext
from operations.operation import ParamSpec
from recipes.recipe import Recipe, Step


class DebugSleepRecipe(Recipe):
    """Shared by the debug recipes: `steps` Sleep steps, one of which can fail."""

    steps = 3
    params = [
        ParamSpec(name="step_seconds", label="Seconds per step", type="number", default=15, min=1, max=3600,
                  tooltip="How long each Sleep step runs. Touches no drive."),
        ParamSpec(name="fail_step", label="Step that fails (0 = none)", type="number", default=0, min=0, max=steps,
                  tooltip="Make this step fail halfway through, to see the rest skipped (or run, with "
                          "stop on failure off)."),
    ]

    def plan(self, context: DriveContext, params: dict) -> list[Step]:
        return [
            Step("debug_sleep", {"duration": params["step_seconds"], "fail": params["fail_step"] == n})
            for n in range(1, self.steps + 1)
        ]
