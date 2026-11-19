"""The built-in recipes' plans, planned against the real operation catalog."""

from types import SimpleNamespace

import pytest

from drives.drive_models import DriveContext, DriveDescriptor, DriveTraits, DriveType
from operations import operation_registry
from recipes import recipe_registry
from recipes.catalog.destructive_stress_test import DestructiveStressTestRecipe, badblocks_block_size
from recipes.catalog.initial_scan import InitialScanRecipe
from recipes.checks import NoIncrease
from recipes.recipe import Check, plan_for_drive
from settings import cfg

TB = 10**12


@pytest.fixture
def operations(monkeypatch):
    """The real operation catalog, discovered into a copy so no global leaks."""
    monkeypatch.setattr(cfg, "_values", dict(cfg._values))
    cfg.set("jobs.enable_debug_operations", False)
    table = operation_registry._OperationTable()
    monkeypatch.setattr(operation_registry, "OPERATIONS", table)
    operation_registry.discover()
    return table


def _drive(drive_type=DriveType.HDD, capacity_bytes=8 * TB, logical_block_size=512) -> DriveContext:
    return DriveContext(
        guid="g1",
        descriptor=DriveDescriptor(device_name="/dev/sdb", access_type="sat", info_name="/dev/sdb"),
        traits=DriveTraits(drive_type=drive_type, capacity_bytes=capacity_bytes, logical_block_size=logical_block_size),
        block_device="sdb",
    )


def _plan(recipe_cls, context, operations, **params):
    recipe = recipe_cls()
    merged = {p.name: p.default for p in recipe.params} | params
    return plan_for_drive("r", recipe, context, merged, operations)


def _steps(planned):
    return [(p.step.operation, p.supported) for p in planned]


# --- Initial scan ---

def test_initial_scan_runs_short_conveyance_long_on_a_sata_drive(operations):
    planned = _plan(InitialScanRecipe, _drive(DriveType.HDD), operations)
    assert _steps(planned) == [
        ("smart_self_test_short", True),
        ("smart_self_test_conveyance", True),
        ("smart_self_test_long", True),
    ]


@pytest.mark.parametrize("drive_type", [DriveType.SAS, DriveType.NVME])
def test_initial_scan_skips_conveyance_where_the_drive_has_none(operations, drive_type):
    planned = _plan(InitialScanRecipe, _drive(drive_type), operations)
    assert _steps(planned) == [
        ("smart_self_test_short", True),
        ("smart_self_test_conveyance", False),
        ("smart_self_test_long", True),
    ]


def test_initial_scan_adds_no_checks_by_default(operations):
    planned = _plan(InitialScanRecipe, _drive(), operations)
    assert all(p.step.check is None for p in planned)


def test_initial_scan_checks_every_step_for_new_remaps_when_asked(operations):
    planned = _plan(InitialScanRecipe, _drive(), operations, fail_on_new_remaps=True)
    assert [p.step.check.to_dict() for p in planned] == [{"kind": "no_increase", "signals": ["reallocated", "pending"]}] * 3


# --- Destructive stress test ---

def test_stress_test_runs_short_badblocks_long_with_the_drives_block_size(operations):
    planned = _plan(DestructiveStressTestRecipe, _drive(capacity_bytes=20 * TB), operations, passes=2)
    assert _steps(planned) == [
        ("smart_self_test_short", True),
        ("badblocks_write_test", True),
        ("smart_self_test_long", True),
    ]
    assert planned[1].params == {"block_size": 8192, "passes": 2}


def test_stress_test_is_marked_destructive():
    # Required for its badblocks step, and lets the UI confirm before planning.
    assert DestructiveStressTestRecipe.destructive is True
    assert InitialScanRecipe.destructive is False


def test_stress_test_adds_no_checks_by_default(operations):
    planned = _plan(DestructiveStressTestRecipe, _drive(), operations)
    assert all(p.step.check is None for p in planned)


# --- badblocks block size ---

@pytest.mark.parametrize("capacity, logical, expected", [
    (8 * TB, 512, 4096),            # 512e drive: still 4096, never below a 4K physical sector
    (8 * TB, 4096, 4096),           # 4Kn
    (16 * TB, 512, 4096),           # 16 TB = 3.9e9 blocks, under 2^32
    (4096 * 2**32 - 1, 512, 4096),  # just under the 4096-byte limit
    (4096 * 2**32, 512, 8192),      # exactly 2^32 blocks: too many
    (20 * TB, 512, 8192),
    (40 * TB, 512, 16384),
    (500 * TB, 512, 65536),         # past the operation's max: capped (badblocks will refuse)
    (None, 512, 4096),              # capacity unknown
    (8 * TB, None, 4096),           # block size unknown
])
def test_badblocks_block_size(capacity, logical, expected):
    assert badblocks_block_size(_drive(capacity_bytes=capacity, logical_block_size=logical)) == expected


# --- NoIncrease ---

def _job(before, after):
    return SimpleNamespace(smart_before=before, smart_after=after)


def _snap(**signals):
    return {"captured_at": "2026-11-18T00:00:00", "signals": signals}


def test_no_increase_passes_when_counts_hold_or_fall():
    check = NoIncrease(["reallocated", "pending"])
    assert check.evaluate(_job(_snap(reallocated=3, pending=2), _snap(reallocated=3, pending=0))) is None


def test_no_increase_fails_with_each_rise():
    check = NoIncrease(["reallocated", "pending"])
    reason = check.evaluate(_job(_snap(reallocated=0, pending=1), _snap(reallocated=4, pending=2)))
    assert reason == "SMART counts rose during this step: reallocated 0 → 4, pending 1 → 2"


@pytest.mark.parametrize("before, after", [
    (None, _snap(reallocated=5)),
    (_snap(reallocated=0), None),
    ({"captured_at": "x", "error": "timeout"}, _snap(reallocated=5)),
    (_snap(reallocated=None), _snap(reallocated=5)),   # signal not reported
    (_snap(), _snap(reallocated=5)),
])
def test_no_increase_passes_when_it_cant_tell(before, after):
    assert NoIncrease(["reallocated"]).evaluate(_job(before, after)) is None


def test_no_increase_survives_a_round_trip():
    rebuilt = Check.from_dict(NoIncrease(["pending"]).to_dict())
    assert isinstance(rebuilt, NoIncrease) and rebuilt.signals == ["pending"]


# --- discovery ---

def test_discover_finds_the_built_in_recipes(monkeypatch):
    monkeypatch.setattr(recipe_registry, "RECIPES", {})
    recipe_registry.discover()
    assert recipe_registry.RECIPES == {
        "destructive_stress_test": DestructiveStressTestRecipe,
        "initial_scan": InitialScanRecipe,
    }
