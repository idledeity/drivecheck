"""recipes.catalog.debug.debug_destructive_batch — Sleep steps marked
destructive, to exercise the destructive confirmation and drive locks.
Writes nothing (see recipes.catalog.debug)."""

from recipes.catalog.debug import DebugSleepRecipe


class DebugDestructiveBatchRecipe(DebugSleepRecipe):
    name = "Destructive Sleep Batch (debug)"
    description = ("Three Sleep steps, marked destructive so starting it asks for confirmation and respects "
                   "drive locks. Writes nothing.")
    destructive = True
