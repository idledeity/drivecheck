import sys

import pytest

# probe_registry doesn't import drive_collector (deliberately decoupled —
# they only coordinate via cfg), but discover() operates on the *_probes
# keys drive_collector.py registers at import time. Imported here purely
# for that side effect, since this is the first test module to exercise
# probe_registry in isolation.
from drives.collector import drive_collector  # noqa: F401
from drives.collector import probe_registry
from settings import cfg


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    """discover() mutates three kinds of global state: cfg._props (via
    set_choices), and sys.path/sys.modules (custom-dir scanning adds the
    isolated_data_dir tmp_path to sys.path and imports modules from it) —
    snapshot and restore all three so this file can't leak into others."""
    monkeypatch.setattr(cfg, "_props", dict(cfg._props))
    monkeypatch.setattr(cfg, "_values", dict(cfg._values))
    original_path = list(sys.path)
    original_modules = set(sys.modules)
    yield
    sys.path[:] = original_path
    for name in set(sys.modules) - original_modules:
        del sys.modules[name]


def _write_probe(path, params: str, body: str = "pass") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"def run({params}):\n    {body}\n")


def test_discover_finds_native_vitals_probes():
    probe_registry.discover()
    choices = cfg._props["collector.vitals_probes"].choices
    assert "drives.collector.probes.vitals.hwmon_temp" in choices
    assert "drives.collector.probes.vitals.smartctl_vitals" in choices
    assert "drives.collector.probes.vitals.sysfs_io" in choices
    assert "drives.collector.probes.vitals.mount_status" in choices


def test_discover_excludes_non_chain_helper_by_arity():
    """block_device.py lives in probes/vitals/ and has a top-level `run`,
    but it's called directly by drive_collector.py (not via the configured
    chain) with one argument instead of vitals' expected two — it should
    not show up as a selectable vitals probe."""
    probe_registry.discover()
    choices = cfg._props["collector.vitals_probes"].choices
    assert not any("block_device" in c for c in choices)


def test_discover_finds_native_probes_for_every_category():
    probe_registry.discover()
    assert cfg._props["collector.scan_probes"].choices == ["drives.collector.probes.scan.smartctl_scan"]
    assert cfg._props["collector.traits_probes"].choices == ["drives.collector.probes.traits.smartctl_traits"]
    assert cfg._props["collector.telemetry_probes"].choices == ["drives.collector.probes.telemetry.smartctl_telemetry"]


def test_discover_finds_a_custom_probe(isolated_data_dir):
    _write_probe(isolated_data_dir / "custom_probes" / "vitals" / "my_custom_vitals.py", "vitals, state")
    probe_registry.discover()
    assert "vitals.my_custom_vitals" in cfg._props["collector.vitals_probes"].choices


def test_discover_excludes_custom_file_with_wrong_arity(isolated_data_dir):
    _write_probe(isolated_data_dir / "custom_probes" / "vitals" / "wrong_arity.py", "only_one_arg")
    probe_registry.discover()
    assert "vitals.wrong_arity" not in cfg._props["collector.vitals_probes"].choices


def test_discover_creates_category_subfolders_with_init(isolated_data_dir):
    probe_registry.discover()
    for category in ("scan", "traits", "telemetry", "vitals"):
        category_dir = isolated_data_dir / "custom_probes" / category
        assert category_dir.is_dir()
        assert (category_dir / "__init__.py").exists()


def test_discover_picks_up_edits_to_an_existing_custom_probe(isolated_data_dir):
    probe_path = isolated_data_dir / "custom_probes" / "scan" / "editable_probe.py"
    _write_probe(probe_path, "", body="return []")
    probe_registry.discover()
    assert "scan.editable_probe" in cfg._props["collector.scan_probes"].choices

    # Edit it to no longer match scan's expected zero-arg signature, then
    # rescan — a stale cached import would still report it as valid.
    _write_probe(probe_path, "unexpected_arg", body="return []")
    probe_registry.discover()
    assert "scan.editable_probe" not in cfg._props["collector.scan_probes"].choices


def test_discover_respects_custom_probes_dir_override(tmp_path, isolated_data_dir):
    other_dir = tmp_path / "elsewhere"
    cfg.set("collector.custom_probes_dir", str(other_dir))
    _write_probe(other_dir / "traits" / "elsewhere_probe.py", "descriptor")
    probe_registry.discover()
    assert "traits.elsewhere_probe" in cfg._props["collector.traits_probes"].choices
    # And the default location (under the data dir) is untouched.
    assert not (isolated_data_dir / "custom_probes").exists()
