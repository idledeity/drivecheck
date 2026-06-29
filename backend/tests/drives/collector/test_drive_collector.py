import logging

from drives.collector.drive_collector import Collector


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
