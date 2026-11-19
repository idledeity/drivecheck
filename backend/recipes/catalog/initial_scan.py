"""
recipes.catalog.initial_scan — first checks on a newly received drive.

Short → Conveyance → Long SMART self-tests. Conveyance looks for shipping
damage but is ATA-only, so SAS and NVMe drives skip it. Nothing is written
to the drive.
"""

from drives.drive_models import DriveContext
from recipes.checks import FAIL_ON_NEW_REMAPS, REMAP_SIGNALS, NoIncrease
from recipes.recipe import Recipe, Step


class InitialScanRecipe(Recipe):
    name = "Initial Scan"
    description = "Short, Conveyance and Long SMART self-tests for a newly received drive. Doesn't write to the drive."
    params = [FAIL_ON_NEW_REMAPS]

    def plan(self, context: DriveContext, params: dict) -> list[Step]:
        check = NoIncrease(REMAP_SIGNALS) if params["fail_on_new_remaps"] else None
        return [
            Step("smart_self_test_short", check=check),
            Step("smart_self_test_conveyance", check=check, if_unsupported="skip"),
            Step("smart_self_test_long", check=check),
        ]
