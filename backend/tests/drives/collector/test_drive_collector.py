import logging

from drives.collector.drive_collector import Collector, _load_probes


def test_load_probes_loads_valid_native_probes():
    result = _load_probes(["drives.collector.probes.scan.smartctl_scan"], "scan")
    assert len(result.modules) == 1
    assert result.modules[0].__name__ == "drives.collector.probes.scan.smartctl_scan"
    assert result.warnings == []


def test_load_probes_skips_a_path_that_fails_to_import(caplog):
    with caplog.at_level(logging.ERROR):
        result = _load_probes(["drives.collector.probes.scan.does_not_exist"], "scan")
    assert result.modules == []
    assert result.warnings == [{
        "path": "drives.collector.probes.scan.does_not_exist",
        "reason": "failed to import: No module named 'drives.collector.probes.scan.does_not_exist'",
    }]
    assert "failed to import" in caplog.text


def test_load_probes_skips_a_probe_with_the_wrong_run_arity(caplog):
    """traits' smartctl_traits.run(descriptor) takes one argument, but scan's
    chain calls run() with zero — listing it under scan_probes (e.g. a
    copy-paste mistake) must not crash Collector.from_config() at startup."""
    with caplog.at_level(logging.ERROR):
        result = _load_probes(["drives.collector.probes.traits.smartctl_traits"], "scan")
    assert result.modules == []
    assert result.warnings == [{
        "path": "drives.collector.probes.traits.smartctl_traits",
        "reason": "run() signature doesn't match scan probes",
    }]
    assert "run() signature doesn't match" in caplog.text


def test_load_probes_keeps_valid_entries_alongside_a_skipped_one(caplog):
    with caplog.at_level(logging.ERROR):
        result = _load_probes(
            ["drives.collector.probes.scan.smartctl_scan", "drives.collector.probes.traits.smartctl_traits"],
            "scan",
        )
    assert [m.__name__ for m in result.modules] == ["drives.collector.probes.scan.smartctl_scan"]
    assert len(result.warnings) == 1


def test_load_probes_returns_empty_result_for_empty_input():
    result = _load_probes([], "vitals")
    assert result.modules == []
    assert result.warnings == []


def _make_collector(**probe_overrides):
    defaults = {
        "scan_probes": ["drives.collector.probes.scan.smartctl_scan"],
        "traits_probes": ["drives.collector.probes.traits.smartctl_traits"],
        "telemetry_probes": ["drives.collector.probes.telemetry.smartctl_telemetry"],
        "vitals_probes": [],
    }
    return Collector(
        scan_interval=300,
        poll_intervals={"telemetry": 300, "snapshot": 14400, "vitals": 10, "traits": 86400},
        keep_history_days=90,
        max_workers=4,
        probe_timeout=30,
        **{**defaults, **probe_overrides},
    )


def test_collector_probe_warnings_is_empty_for_an_all_valid_config():
    collector = _make_collector()
    assert collector.probe_warnings == {
        "collector.scan_probes": [],
        "collector.traits_probes": [],
        "collector.telemetry_probes": [],
        "collector.vitals_probes": [],
    }


def test_collector_probe_warnings_reports_a_bad_entry_under_its_own_category(caplog):
    with caplog.at_level(logging.ERROR):
        collector = _make_collector(vitals_probes=["drives.collector.probes.scan.smartctl_scan"])
    assert collector.probe_warnings["collector.vitals_probes"] == [{
        "path": "drives.collector.probes.scan.smartctl_scan",
        "reason": "run() signature doesn't match vitals probes",
    }]
    assert collector.probe_warnings["collector.scan_probes"] == []
