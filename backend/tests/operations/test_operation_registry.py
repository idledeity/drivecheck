import pytest

from operations import operation_registry
from operations.operation import OperationBase
from settings import cfg


@pytest.fixture(autouse=True)
def isolated_registry_state(monkeypatch):
    """discover() mutates two module-globals (cfg._values and OPERATIONS) that
    other code imports directly — snapshot both so this file can't leak
    state into tests that run before or after it."""
    monkeypatch.setattr(cfg, "_values", dict(cfg._values))
    snapshot = operation_registry._OperationTable()
    snapshot.update(operation_registry.OPERATIONS)
    snapshot.aliases = dict(operation_registry.OPERATIONS.aliases)
    monkeypatch.setattr(operation_registry, "OPERATIONS", snapshot)


def test_discover_finds_non_debug_operations():
    cfg.set("jobs.enable_debug_operations", False)
    operation_registry.discover()
    assert "dd_read_test" in operation_registry.OPERATIONS
    assert "smart_self_test_short" in operation_registry.OPERATIONS
    assert "smart_self_test_long" in operation_registry.OPERATIONS


def test_discover_excludes_debug_operations_by_default_flag():
    cfg.set("jobs.enable_debug_operations", False)
    operation_registry.discover()
    assert "debug_sleep" not in operation_registry.OPERATIONS


def test_discover_includes_debug_operations_when_enabled():
    cfg.set("jobs.enable_debug_operations", True)
    operation_registry.discover()
    assert "debug_sleep" in operation_registry.OPERATIONS


def test_discover_excludes_abstract_base_classes():
    cfg.set("jobs.enable_debug_operations", False)
    operation_registry.discover()
    assert "smart_self_test_base" not in operation_registry.OPERATIONS


def test_discover_clears_previous_results():
    cfg.set("jobs.enable_debug_operations", True)
    operation_registry.discover()
    assert "debug_sleep" in operation_registry.OPERATIONS
    cfg.set("jobs.enable_debug_operations", False)
    operation_registry.discover()
    assert "debug_sleep" not in operation_registry.OPERATIONS


def test_discovered_operations_are_operation_base_subclasses():
    cfg.set("jobs.enable_debug_operations", False)
    operation_registry.discover()
    for op_cls in operation_registry.OPERATIONS.values():
        assert issubclass(op_cls, OperationBase)


def test_former_keys_resolve_but_are_not_listed():
    # NVMe self-tests were their own operations before they merged into the
    # SMART ones; job rows and history still carry the old keys.
    cfg.set("jobs.enable_debug_operations", False)
    operation_registry.discover()
    ops = operation_registry.OPERATIONS
    assert ops.get("nvme_self_test_short") is ops["smart_self_test_short"]
    assert ops["nvme_self_test_long"] is ops["smart_self_test_long"]
    assert "nvme_self_test_short" not in list(ops)
    assert ops.get("no_such_operation") is None
    with pytest.raises(KeyError):
        ops["no_such_operation"]
