import json
import logging
from pathlib import Path

from database import db
from drives.collector.drive_collector import Collector
from drives.collector.probes.telemetry import smartctl_telemetry
from drives.drive_models import DriveContext, DriveDescriptor, DriveState, DriveTraits, DriveType


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


# Real smartctl -j -a fields from a SAS drive (only the self-test parts are kept in
# the fixture, so most signals come back None — the shapes are what's checked).
_SAS_DATA = json.loads(
    (Path(__file__).parents[2] / "operations" / "fixtures" / "smart_sas_short_selftest.json").read_text()
)["completed"]


def _collector_with_drive(monkeypatch, attributes_all=lambda _d, _a: _SAS_DATA):
    db.init()
    monkeypatch.setattr(smartctl_telemetry.smartctl, "attributes_all", attributes_all)
    collector = _make_collector()
    context = DriveContext(guid="g1", descriptor=DriveDescriptor("/dev/sdz", "scsi", "/dev/sdz"),
                           traits=DriveTraits(drive_type=DriveType.SAS))
    collector._drive_states["g1"] = DriveState(context=context)
    return collector


def test_capture_smart_forces_a_poll_and_saves_its_full_report(monkeypatch):
    collector = _collector_with_drive(monkeypatch)
    summary = collector.capture_smart("g1")
    assert set(summary) == {"snapshot_id", "captured_at", "signals", "health", "reused"}
    assert summary["reused"] is False
    assert summary["signals"]["power_on_hours"] == _SAS_DATA["power_on_time"]["hours"]
    report = json.loads(db.get_raw_snapshot(summary["snapshot_id"])["raw_json"])
    assert report["smartctl"] == _SAS_DATA
    # Same path as a scheduled poll: the reading lands in the signal history and live state.
    with db._connection() as conn:
        captured = {r[0] for r in conn.execute("SELECT captured_at FROM drive_signals WHERE drive_guid = 'g1'")}
    assert captured == {summary["captured_at"]}
    assert collector._drive_states["g1"].snapshot.telemetry.last_polled_at is not None
    assert collector.capture_smart("unknown") is None


def test_capture_smart_reuses_a_recent_snapshot_within_max_age(monkeypatch):
    collector = _collector_with_drive(monkeypatch)
    first = collector.capture_smart("g1")
    reused = collector.capture_smart("g1", max_age_seconds=300)
    assert reused == {**first, "reused": True}


def test_capture_smart_takes_a_new_one_when_the_latest_is_too_old(monkeypatch):
    collector = _collector_with_drive(monkeypatch)
    first = collector.capture_smart("g1")
    collector._latest_snapshots["g1"]["captured_at"] = "2020-01-01T00:00:00"
    second = collector.capture_smart("g1", max_age_seconds=300)
    assert second["reused"] is False and second["snapshot_id"] != first["snapshot_id"]
    third = collector.capture_smart("g1", max_age_seconds=0)  # 0 never reuses
    assert third["reused"] is False and third["snapshot_id"] != second["snapshot_id"]


def test_a_scheduled_snapshot_counts_as_the_latest_for_reuse(monkeypatch):
    collector = _collector_with_drive(monkeypatch)
    state = collector._drive_states["g1"]
    collector._run_telemetry(state, 0)
    collector._run_snapshot(state, 0)
    reused = collector.capture_smart("g1", max_age_seconds=300)
    assert reused["reused"] is True
    assert db.get_raw_snapshot(reused["snapshot_id"]) is not None


def test_capture_smart_reports_a_probe_failure_instead_of_raising(monkeypatch):
    def _boom(_d, _a):
        raise OSError("device vanished")

    collector = _collector_with_drive(monkeypatch, attributes_all=_boom)
    summary = collector.capture_smart("g1")
    assert summary["error"] == "device vanished"
    assert "captured_at" in summary
