import logging
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


class TestLoadProbes:
    def test_loads_a_valid_native_probe(self):
        result = probe_registry.load_probes(["drives.collector.probes.scan.smartctl_scan"], "scan")
        assert len(result.modules) == 1
        assert result.modules[0].__name__ == "drives.collector.probes.scan.smartctl_scan"
        assert result.warnings == []

    def test_skips_a_path_that_fails_to_import(self, caplog):
        with caplog.at_level(logging.ERROR):
            result = probe_registry.load_probes(["drives.collector.probes.scan.does_not_exist"], "scan")
        assert result.modules == []
        assert result.warnings == [{
            "path": "drives.collector.probes.scan.does_not_exist",
            "reason": "failed to import: No module named 'drives.collector.probes.scan.does_not_exist'",
        }]
        assert "failed to import" in caplog.text

    def test_skips_a_probe_with_the_wrong_run_arity(self, caplog):
        """traits' smartctl_traits.run(descriptor) takes one argument, but
        scan's chain calls run() with zero — listing it under scan_probes
        (e.g. a copy-paste mistake) must not crash Collector.from_config()
        at startup."""
        with caplog.at_level(logging.ERROR):
            result = probe_registry.load_probes(["drives.collector.probes.traits.smartctl_traits"], "scan")
        assert result.modules == []
        assert result.warnings == [{
            "path": "drives.collector.probes.traits.smartctl_traits",
            "reason": "run() signature doesn't match scan probes",
        }]
        assert "run() signature doesn't match" in caplog.text

    def test_keeps_valid_entries_alongside_a_skipped_one(self, caplog):
        with caplog.at_level(logging.ERROR):
            result = probe_registry.load_probes(
                ["drives.collector.probes.scan.smartctl_scan", "drives.collector.probes.traits.smartctl_traits"],
                "scan",
            )
        assert [m.__name__ for m in result.modules] == ["drives.collector.probes.scan.smartctl_scan"]
        assert len(result.warnings) == 1

    def test_handles_empty_input(self):
        result = probe_registry.load_probes([], "vitals")
        assert result.modules == []
        assert result.warnings == []


class TestWriteProbeFile:
    def test_writes_an_importable_file_and_it_becomes_discoverable(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "my_new_probe", b"def run(vitals, state):\n    return vitals\n")
        dest = isolated_data_dir / "custom_probes" / "vitals" / "my_new_probe.py"
        assert dest.exists()

        probe_registry.discover()
        assert "vitals.my_new_probe" in cfg._props["collector.vitals_probes"].choices

    def test_rejects_an_unknown_category(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeWriteError, match="unknown probe category"):
            probe_registry.write_probe_file("not_a_category", "x", b"")
        assert not (isolated_data_dir / "custom_probes").exists()

    def test_rejects_an_invalid_name(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeWriteError, match="valid Python identifier"):
            probe_registry.write_probe_file("vitals", "../escape", b"")

    def test_rejects_a_name_that_already_exists(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "dup", b"def run(vitals, state):\n    return vitals\n")
        with pytest.raises(probe_registry.ProbeWriteError, match="already exists"):
            probe_registry.write_probe_file("vitals", "dup", b"def run(vitals, state):\n    return vitals\n")

    def test_cleans_up_a_file_that_fails_to_import(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeWriteError, match="failed to import"):
            probe_registry.write_probe_file("vitals", "broken", b"this is not valid python(((\n")
        assert not (isolated_data_dir / "custom_probes" / "vitals" / "broken.py").exists()

    def test_cleans_up_a_file_with_the_wrong_arity(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeWriteError, match="doesn't match vitals probes"):
            probe_registry.write_probe_file("vitals", "wrong_shape", b"def run(only_one_arg):\n    pass\n")
        assert not (isolated_data_dir / "custom_probes" / "vitals" / "wrong_shape.py").exists()

    def test_a_failed_write_does_not_poison_a_later_successful_one_with_the_same_name(self, isolated_data_dir):
        """A stale sys.modules entry from the failed attempt must not cause
        a later write reusing the same name to resolve to old, deleted
        content instead of re-importing the new file from disk."""
        with pytest.raises(probe_registry.ProbeWriteError):
            probe_registry.write_probe_file("vitals", "reused_name", b"def run(only_one_arg):\n    pass\n")

        probe_registry.write_probe_file("vitals", "reused_name", b"def run(vitals, state):\n    return vitals\n")
        probe_registry.discover()
        assert "vitals.reused_name" in cfg._props["collector.vitals_probes"].choices

    def test_overwrite_replaces_an_existing_custom_probes_content(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "editable", b"def run(vitals, state):\n    return vitals\n")
        probe_registry.write_probe_file(
            "vitals", "editable", b"def run(vitals, state):\n    return state\n", overwrite=True,
        )
        content, editable = probe_registry.read_probe_source("vitals", "vitals.editable")
        assert "return state" in content
        assert editable is True

    def test_overwrite_of_a_not_yet_existing_name_raises_lookup_error(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeLookupError, match="no longer exists"):
            probe_registry.write_probe_file(
                "vitals", "never_created", b"def run(vitals, state):\n    return vitals\n", overwrite=True,
            )

    def test_overwrite_that_fails_validation_restores_the_original_content(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "guarded", b"def run(vitals, state):\n    return vitals\n")
        with pytest.raises(probe_registry.ProbeWriteError, match="doesn't match vitals probes"):
            probe_registry.write_probe_file(
                "vitals", "guarded", b"def run(only_one_arg):\n    pass\n", overwrite=True,
            )
        content, _editable = probe_registry.read_probe_source("vitals", "vitals.guarded")
        assert "return vitals" in content

        probe_registry.discover()
        assert "vitals.guarded" in cfg._props["collector.vitals_probes"].choices


class TestReadProbeSource:
    def test_reads_a_native_probe_as_not_editable(self):
        content, editable = probe_registry.read_probe_source(
            "scan", "drives.collector.probes.scan.smartctl_scan",
        )
        assert "def run(" in content
        assert editable is False

    def test_reads_a_custom_probe_as_editable(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "readable", b"def run(vitals, state):\n    return vitals\n")
        content, editable = probe_registry.read_probe_source("vitals", "vitals.readable")
        assert "return vitals" in content
        assert editable is True

    def test_rejects_an_unknown_category(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeLookupError, match="unknown probe category"):
            probe_registry.read_probe_source("not_a_category", "not_a_category.x")

    def test_rejects_a_path_that_does_not_match_the_category(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeLookupError, match="not a vitals probe"):
            probe_registry.read_probe_source("vitals", "traits.something")

    def test_raises_for_a_custom_file_deleted_from_disk(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "vanishing", b"def run(vitals, state):\n    return vitals\n")
        (isolated_data_dir / "custom_probes" / "vitals" / "vanishing.py").unlink()
        with pytest.raises(probe_registry.ProbeLookupError, match="no longer exists"):
            probe_registry.read_probe_source("vitals", "vitals.vanishing")


class TestDeleteProbeFile:
    def test_deletes_a_custom_probe_and_clears_its_module_cache(self, isolated_data_dir):
        probe_registry.write_probe_file("vitals", "doomed", b"def run(vitals, state):\n    return vitals\n")
        assert "vitals.doomed" in sys.modules
        dest = isolated_data_dir / "custom_probes" / "vitals" / "doomed.py"
        assert dest.exists()

        probe_registry.delete_probe_file("vitals", "vitals.doomed")
        assert not dest.exists()
        assert "vitals.doomed" not in sys.modules

        probe_registry.discover()
        assert "vitals.doomed" not in cfg._props["collector.vitals_probes"].choices

    def test_rejects_an_unknown_category(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeLookupError, match="unknown probe category"):
            probe_registry.delete_probe_file("not_a_category", "not_a_category.x")

    def test_rejects_a_native_probe(self):
        with pytest.raises(probe_registry.ProbeLookupError, match="native probes can't be deleted"):
            probe_registry.delete_probe_file("scan", "drives.collector.probes.scan.smartctl_scan")

    def test_rejects_a_custom_probe_that_does_not_exist(self, isolated_data_dir):
        with pytest.raises(probe_registry.ProbeLookupError, match="no longer exists"):
            probe_registry.delete_probe_file("vitals", "vitals.never_existed")


class TestProbeTemplates:
    @pytest.mark.parametrize("category", ["scan", "traits", "telemetry", "vitals"])
    def test_each_template_is_a_valid_probe_for_its_own_category(self, category, isolated_data_dir):
        template = probe_registry.PROBE_TEMPLATES[category]
        content = template.format(name="from_template").encode()
        probe_registry.write_probe_file(category, "from_template", content)  # must not raise

        probe_registry.discover()
        assert f"{category}.from_template" in cfg._props[probe_registry.probe_key(category)].choices
