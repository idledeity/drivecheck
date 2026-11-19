"""
recipes.catalog.destructive_stress_test — full write/read workout for a
second-hand or repurposed drive before it joins an array.

Short self-test → badblocks -w over the whole drive → Long self-test, so the
Long test reads back a surface that has just been written end to end.
ERASES THE DRIVE.
"""

from drives.drive_models import DriveContext
from operations.operation import ParamSpec
from recipes.checks import FAIL_ON_NEW_REMAPS, REMAP_SIGNALS, NoIncrease
from recipes.recipe import Recipe, Step

# badblocks counts blocks in 32 bits, so a drive must have fewer than 2^32
# blocks at the chosen size: 4096-byte blocks cover drives up to ~17.6 TB.
_BADBLOCKS_MAX_BLOCKS = 2**32
_BADBLOCKS_MIN_BLOCK_SIZE = 4096      # a 4K-sector drive must not be tested in smaller blocks
_BADBLOCKS_MAX_BLOCK_SIZE = 65536     # the operation's own limit


def badblocks_block_size(context: DriveContext) -> int:
    """The block size badblocks should use on this drive: 4096 (or the drive's
    logical block size, if larger), doubled until the drive has fewer than
    2^32 blocks. 4096 if the capacity isn't known."""
    size = max(_BADBLOCKS_MIN_BLOCK_SIZE, context.traits.logical_block_size or 0)
    capacity = context.traits.capacity_bytes
    if capacity:
        while capacity // size >= _BADBLOCKS_MAX_BLOCKS and size < _BADBLOCKS_MAX_BLOCK_SIZE:
            size *= 2
    return size


class DestructiveStressTestRecipe(Recipe):
    name = "Destructive Stress Test"
    description = ("Short self-test, a badblocks write test over the whole drive, then a Long self-test. "
                   "For second-hand or repurposed drives before they hold data. Erases the drive.")
    destructive = True
    params = [
        ParamSpec(name="passes", label="badblocks passes", type="number", default=1, min=1, max=4,
                  tooltip="How many times badblocks writes and reads back its four patterns over the whole drive. "
                          "Each pass is roughly eight full-drive passes of time."),
        FAIL_ON_NEW_REMAPS,
    ]

    def plan(self, context: DriveContext, params: dict) -> list[Step]:
        check = NoIncrease(REMAP_SIGNALS) if params["fail_on_new_remaps"] else None
        badblocks = {"block_size": badblocks_block_size(context), "passes": params["passes"]}
        return [
            Step("smart_self_test_short", check=check),
            Step("badblocks_write_test", badblocks, check=check),
            Step("smart_self_test_long", check=check),
        ]
