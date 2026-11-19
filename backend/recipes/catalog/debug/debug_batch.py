"""recipes.catalog.debug.debug_batch — three quick Sleep steps (see recipes.catalog.debug)."""

from recipes.catalog.debug import DebugSleepRecipe


class DebugBatchRecipe(DebugSleepRecipe):
    name = "Sleep Batch (debug)"
    description = "Three Sleep steps that touch no drive, for trying out batches quickly."
