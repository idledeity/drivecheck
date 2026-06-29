import logging

from drives.collector.drive_collector import _load_probes


def test_load_probes_loads_valid_native_probes():
    modules = _load_probes(["drives.collector.probes.scan.smartctl_scan"], "scan")
    assert len(modules) == 1
    assert modules[0].__name__ == "drives.collector.probes.scan.smartctl_scan"


def test_load_probes_skips_a_path_that_fails_to_import(caplog):
    with caplog.at_level(logging.ERROR):
        modules = _load_probes(["drives.collector.probes.scan.does_not_exist"], "scan")
    assert modules == []
    assert "failed to import" in caplog.text


def test_load_probes_skips_a_probe_with_the_wrong_run_arity(caplog):
    """traits' smartctl_traits.run(descriptor) takes one argument, but scan's
    chain calls run() with zero — listing it under scan_probes (e.g. a
    copy-paste mistake) must not crash Collector.from_config() at startup."""
    with caplog.at_level(logging.ERROR):
        modules = _load_probes(["drives.collector.probes.traits.smartctl_traits"], "scan")
    assert modules == []
    assert "run() signature doesn't match" in caplog.text


def test_load_probes_keeps_valid_entries_alongside_a_skipped_one(caplog):
    with caplog.at_level(logging.ERROR):
        modules = _load_probes(
            ["drives.collector.probes.scan.smartctl_scan", "drives.collector.probes.traits.smartctl_traits"],
            "scan",
        )
    assert [m.__name__ for m in modules] == ["drives.collector.probes.scan.smartctl_scan"]


def test_load_probes_returns_empty_list_for_empty_input():
    assert _load_probes([], "vitals") == []
