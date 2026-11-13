import json
import logging
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

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


def test_health_is_scored_after_the_whole_telemetry_chain(monkeypatch):
    # A later probe correcting a signal must be what health is judged on.
    collector = _collector_with_drive(monkeypatch)
    def mark_failing(snapshot, _context):
        signals = replace(snapshot.telemetry.signals, smart_passed=False, uncorrected=3)
        snapshot.telemetry = replace(snapshot.telemetry, signals=signals)
        return snapshot
    collector._telemetry_probes = [*collector._telemetry_probes, SimpleNamespace(run=mark_failing)]
    state = collector._drive_states["g1"]
    snapshot = collector._run_telemetry(state, 0)
    assert snapshot.health.health_status == "Failing"
    assert snapshot.health.signal_flags["uncorrected"] == "crit"
    assert snapshot.health.signal_flags["smart_passed"] == "crit"
    assert state.snapshot.health is snapshot.health


def test_a_probe_that_never_scores_health_still_gets_a_rating(monkeypatch):
    collector = _collector_with_drive(monkeypatch)
    def facts_only(snapshot, _context):
        snapshot.telemetry = replace(snapshot.telemetry, signals=replace(snapshot.telemetry.signals, smart_passed=True))
        return snapshot
    collector._telemetry_probes = [smartctl_telemetry, SimpleNamespace(run=facts_only)]
    snapshot = collector._run_telemetry(collector._drive_states["g1"], 0)
    assert snapshot.health.health_status is not None


def test_capture_smart_forces_a_poll_and_saves_its_full_report(monkeypatch):
    collector = _collector_with_drive(monkeypatch)
    summary = collector.capture_smart("g1")
    assert set(summary) == {"snapshot_id", "captured_at", "signals", "reused"}
    assert summary["reused"] is False
    assert summary["signals"]["power_on_hours"] == _SAS_DATA["power_on_time"]["hours"]
    report = json.loads(db.get_raw_snapshot(summary["snapshot_id"])["raw_json"])
    assert report["smartctl"] == _SAS_DATA
    # Facts only: the signals to judge it by, and rows without statuses.
    assert report["signals"] == summary["signals"]
    assert report["self_test_log"] and all("status" not in row for row in report["self_test_log"])
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


# --- Discovery: identity checks on known paths, failed scans ----------------

class _Bays:
    """Fake scan + traits probes over a mutable {device_name: serial} map."""

    def __init__(self, **bays):
        self.bays = dict(bays)
        self.scan_fails = False
        self.unreadable: set[str] = set()

    def scan_probe(self):
        def run():
            if self.scan_fails:
                raise RuntimeError("smartctl --scan-open timed out")
            return [DriveDescriptor(f"/dev/{name}", "sat", f"/dev/{name}") for name in self.bays]
        return SimpleNamespace(run=run, __name__="fake_scan")

    def traits_probe(self):
        def run(descriptor):
            name = descriptor.device_name.removeprefix("/dev/")
            if name in self.unreadable:
                return DriveTraits()
            return DriveTraits(serial=self.bays[name], model="Fake")
        return SimpleNamespace(run=run)


def _collector_over(monkeypatch, bays: _Bays):
    db.init()
    from drives.collector import drive_collector
    # lsblk stand-in: a serial's block device is whichever bay holds it now.
    monkeypatch.setattr(drive_collector, "resolve_block_device",
                        lambda serial: next((n for n, s in bays.bays.items() if s == serial), None))
    collector = _make_collector()
    collector._scan_probes = [bays.scan_probe()]
    collector._traits_probes = [bays.traits_probe()]
    return collector


def _by_serial(collector):
    return {s.traits.serial: s for s in collector.get_drive_states()}


def test_a_drive_swapped_into_a_known_bay_gets_its_own_identity(monkeypatch):
    bays = _Bays(sdb="SER-A")
    collector = _collector_over(monkeypatch, bays)
    collector._run_scan(0)
    old = _by_serial(collector)["SER-A"]
    collector.set_drive_locked(old.context.guid, True)

    bays.bays["sdb"] = "SER-B"
    collector._run_scan(1)

    states = _by_serial(collector)
    assert set(states) == {"SER-B"}
    new = states["SER-B"]
    assert new.context.guid != old.context.guid
    assert new.locked is False
    assert new.context.descriptor.device_name == "/dev/sdb"


def test_an_unreadable_serial_on_a_known_bay_keeps_the_drive(monkeypatch):
    bays = _Bays(sdb="SER-A")
    collector = _collector_over(monkeypatch, bays)
    collector._run_scan(0)
    guid = _by_serial(collector)["SER-A"].context.guid

    bays.unreadable.add("sdb")
    collector._run_scan(1)

    assert [s.context.guid for s in collector.get_drive_states()] == [guid]


def test_drives_trading_bays_keep_their_identities_and_follow_their_paths(monkeypatch):
    bays = _Bays(sdb="SER-A", sdc="SER-B")
    collector = _collector_over(monkeypatch, bays)
    collector._run_scan(0)
    guids = {serial: s.context.guid for serial, s in _by_serial(collector).items()}

    bays.bays = {"sdb": "SER-B", "sdc": "SER-A"}
    collector._run_scan(1)

    states = _by_serial(collector)
    assert {serial: s.context.guid for serial, s in states.items()} == guids
    for serial, bay in (("SER-A", "sdc"), ("SER-B", "sdb")):
        state = states[serial]
        assert [d.device_name for d in state.attachment.descriptors] == [f"/dev/{bay}"]
        assert state.context.descriptor.device_name == f"/dev/{bay}"
        assert state.context.block_device == bay


def test_a_failed_scan_leaves_the_registry_unchanged(monkeypatch):
    bays = _Bays(sdb="SER-A", sdc="SER-B")
    collector = _collector_over(monkeypatch, bays)
    collector._run_scan(0)
    before = {s.context.guid for s in collector.get_drive_states()}

    bays.scan_fails = True
    assert collector._run_scan(1) is False
    assert {s.context.guid for s in collector.get_drive_states()} == before

    collector._scan_probes = [SimpleNamespace(run=lambda: None, __name__="none_scan")]
    assert collector._run_scan(2) is False
    assert {s.context.guid for s in collector.get_drive_states()} == before


def test_a_failed_first_scan_still_counts_as_scanned(monkeypatch):
    bays = _Bays(sdb="SER-A")
    bays.scan_fails = True
    collector = _collector_over(monkeypatch, bays)
    collector._tick()
    assert collector._scanned.is_set()
    assert collector.get_drive_states() == []


def test_smartctl_scan_probe_raises_on_a_timed_out_scan(monkeypatch):
    import pytest
    from drives.collector.probes.scan import smartctl_scan
    monkeypatch.setattr(smartctl_scan.smartctl, "scan", lambda: {})
    with pytest.raises(RuntimeError):
        smartctl_scan.run()
    # Real shape of an empty-but-successful scan: no drives, no error.
    monkeypatch.setattr(smartctl_scan.smartctl, "scan", lambda: {"smartctl": {"exit_status": 0}, "devices": []})
    assert smartctl_scan.run() == []


def test_a_renamed_block_device_is_picked_up_on_the_next_scan(monkeypatch):
    bays = _Bays(sdb="SER-A")
    collector = _collector_over(monkeypatch, bays)
    collector._run_scan(0)
    state = _by_serial(collector)["SER-A"]
    assert state.context.block_device == "sdb"

    # Same smartctl path, new kernel name (e.g. replugged behind an HBA).
    from drives.collector import drive_collector
    monkeypatch.setattr(drive_collector, "resolve_block_device", lambda serial: "sdf")
    collector._run_scan(1)
    assert state.context.block_device == "sdf"
    assert state.context.block_device_path == "/dev/sdf"


def _raw_vitals(guid, captured_at, temp_c):
    from drives.drive_models import DriveIOActivity
    db.record_vitals(guid, captured_at, temp_c=temp_c, temp_source="hwmon", io=DriveIOActivity())


def _rolled_minutes():
    with db._connection() as conn:
        return [r[0] for r in conn.execute("SELECT captured_at FROM drive_vitals_rollup ORDER BY captured_at")]


def _epoch(iso):
    from datetime import datetime
    return datetime.fromisoformat(iso).timestamp()


def test_rollup_vitals_backfills_then_rolls_only_minutes_past_the_grace_period():
    db.init()
    for minute in ("10:00", "10:01", "10:02", "10:03"):
        _raw_vitals("guid-1", f"2026-01-01T{minute}:30", 30)
    collector = _make_collector()

    # 10:03:30 — minute 10:02 ended only 30s ago, so it waits; 10:00 and 10:01 roll.
    collector._rollup_vitals(_epoch("2026-01-01T10:03:30"))
    assert _rolled_minutes() == ["2026-01-01T10:00:00", "2026-01-01T10:01:00"]

    collector._rollup_vitals(_epoch("2026-01-01T10:05:00"))
    assert _rolled_minutes() == [f"2026-01-01T10:0{m}:00" for m in range(4)]


def test_rollup_vitals_after_a_restart_re_rolls_the_newest_minute():
    db.init()
    _raw_vitals("guid-1", "2026-01-01T10:00:10", 30)
    _make_collector()._rollup_vitals(_epoch("2026-01-01T10:02:00"))
    # A sample for 10:00 that arrived after that minute was rolled up.
    _raw_vitals("guid-1", "2026-01-01T10:00:50", 40)

    _make_collector()._rollup_vitals(_epoch("2026-01-01T10:02:30"))
    with db._connection() as conn:
        assert conn.execute("SELECT temp_n, temp_avg FROM drive_vitals_rollup").fetchall() == [(2, 35.0)]
