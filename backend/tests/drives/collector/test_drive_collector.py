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


def _collector_with_drive(monkeypatch, full_read=lambda _d, _a: _SAS_DATA):
    db.init()
    monkeypatch.setattr(smartctl_telemetry.smartctl, "full_read", full_read)
    collector = _make_collector()
    context = DriveContext(guid="g1", descriptor=DriveDescriptor("/dev/sdz", "scsi", "/dev/sdz"),
                           traits=DriveTraits(drive_type=DriveType.SAS))
    collector._drive_states["g1"] = DriveState(context=context)
    return collector


def test_health_is_scored_after_the_whole_telemetry_chain(monkeypatch):
    # A later probe correcting a signal must be what health is judged on.
    collector = _collector_with_drive(monkeypatch)
    def mark_failing(snapshot, _context):
        signals = replace(snapshot.telemetry.signals, smart_passed=False, uncorrected=10)
        snapshot.telemetry = replace(snapshot.telemetry, signals=signals)
        return snapshot
    collector._telemetry_probes = [*collector._telemetry_probes, SimpleNamespace(run=mark_failing)]
    state = collector._drive_states["g1"]
    snapshot = collector._run_telemetry(state, 0)
    assert snapshot.health.health_status == "Critical"
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

    collector = _collector_with_drive(monkeypatch, full_read=_boom)
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


def _rolled_half_hours():
    with db._connection() as conn:
        return conn.execute("SELECT captured_at, temp_n FROM drive_vitals_rollup_30m ORDER BY captured_at").fetchall()


def test_rollup_vitals_keeps_the_current_half_hour_up_to_date():
    db.init()
    _raw_vitals("guid-1", "2026-01-01T09:59:30", 30)
    _raw_vitals("guid-1", "2026-01-01T10:00:30", 30)
    collector = _make_collector()
    collector._rollup_vitals(_epoch("2026-01-01T10:02:00"))
    assert _rolled_half_hours() == [("2026-01-01T09:30:00", 1), ("2026-01-01T10:00:00", 1)]

    _raw_vitals("guid-1", "2026-01-01T10:01:30", 30)
    collector._rollup_vitals(_epoch("2026-01-01T10:03:00"))
    assert _rolled_half_hours() == [("2026-01-01T09:30:00", 1), ("2026-01-01T10:00:00", 2)]


# --- SMART read tiers: busy-gated attribute reads, full reads, restore ------

class _Reads:
    """Stand-ins for smartctl's full (-x -a) and attribute (-A -H) reads, counting each."""

    def __init__(self, monkeypatch):
        self.full = 0
        self.attributes: list[tuple[str, ...]] = []  # logs per call
        monkeypatch.setattr(smartctl_telemetry.smartctl, "full_read", self._full)
        monkeypatch.setattr(smartctl_telemetry.smartctl, "attributes_and_health", self._attributes)

    def _full(self, _d, _a):
        self.full += 1
        return _SAS_DATA

    def _attributes(self, _d, _a, logs=()):
        self.attributes.append(logs)
        # An attribute read has no self-test log.
        return {k: v for k, v in _SAS_DATA.items() if not k.startswith("scsi_self_test")}


def _tiered(monkeypatch, window=60):
    db.init()
    reads = _Reads(monkeypatch)
    collector = _make_collector(activity_window=window)
    context = DriveContext(guid="g1", descriptor=DriveDescriptor("/dev/sdz", "scsi", "/dev/sdz"),
                           traits=DriveTraits(drive_type=DriveType.SAS))
    collector._drive_states["g1"] = DriveState(context=context)
    collector._schedules["g1"] = {"telemetry": 0, "snapshot": 10**10, "vitals": 10**10, "traits": 10**10}
    # A tick (trigger_poll) would otherwise scan the real drives, prune and roll up.
    collector._scan_due = collector._prune_due = collector._rollup_due = float("inf")
    return collector, reads


def _run(collector, channel, now):
    future = collector._maybe_run_channel(collector._drive_states["g1"], channel, now)
    if future is not None:
        future.result()
    return future is not None


def test_an_idle_drive_s_attribute_read_waits_until_it_is_busy(monkeypatch):
    collector, reads = _tiered(monkeypatch)
    collector._last_io_at["g1"] = 1000.0
    # Last I/O 2 minutes ago: heads may be parked, so no read, and it stays due.
    assert not _run(collector, "telemetry", 1120.0)
    assert collector._schedules["g1"]["telemetry"] == 0
    # Busy again: the pending read runs, and the next is a slot away.
    collector._last_io_at["g1"] = 1125.0
    assert _run(collector, "telemetry", 1130.0)
    assert reads.attributes == [("error", "background", "sasphy")] and reads.full == 0
    assert collector._schedules["g1"]["telemetry"] > 1130.0


def test_a_drive_whose_io_can_t_be_measured_is_read_on_schedule(monkeypatch):
    collector, reads = _tiered(monkeypatch)
    assert _run(collector, "telemetry", 1000.0)
    assert len(reads.attributes) == 1


def test_window_zero_reads_on_schedule_even_when_idle(monkeypatch):
    collector, reads = _tiered(monkeypatch, window=0)
    collector._last_io_at["g1"] = 0.0
    assert _run(collector, "telemetry", 1000.0)


def test_vitals_mark_a_drive_busy_only_when_it_did_io(monkeypatch):
    from datetime import datetime
    from drives.drive_models import DriveIOActivity, DriveVitals
    collector, _ = _tiered(monkeypatch)
    state = collector._drive_states["g1"]
    io = {"none": DriveIOActivity(), "idle": DriveIOActivity(0, 0, 0, 0, 0), "busy": DriveIOActivity(5, 0, 4096, 0, 1)}
    def vitals(at, kind):
        collector._vitals_probes = [SimpleNamespace(run=lambda v, _s: replace(v, io=io[kind]))]
        monkeypatch.setattr("drives.collector.drive_collector.datetime",
                            SimpleNamespace(now=lambda: datetime.fromtimestamp(at), fromtimestamp=datetime.fromtimestamp))
        collector._run_vitals(state, at)
    vitals(990.0, "none")  # no rates yet (first reading, or no block device)
    assert "g1" not in collector._last_io_at
    vitals(1000.0, "idle")
    assert collector._last_io_at["g1"] == 0.0  # measurable, but not busy since start-up
    vitals(1010.0, "busy")
    vitals(1020.0, "idle")
    assert collector._last_io_at["g1"] == 1010.0


def test_an_attribute_read_keeps_the_last_full_read_s_self_test_log(monkeypatch):
    collector, reads = _tiered(monkeypatch)
    state = collector._drive_states["g1"]
    collector._run_telemetry(state, 0)
    log = state.snapshot.extras["self_test_log"]
    assert log
    collector._run_telemetry(state, 10, full=False)
    assert state.snapshot.extras["self_test_log"] == log
    assert state.snapshot.extras["smart_attributes"] is not None
    assert (reads.full, len(reads.attributes)) == (1, 1)


def test_an_attribute_read_carries_forward_signals_its_output_lacks(monkeypatch):
    fixtures = Path(__file__).parents[2] / "analysis" / "fixtures"
    full = json.loads((fixtures / "smartctl_full_reads_x.json").read_text())["hgst_hus726060_sas"]
    attrs = json.loads((fixtures / "smartctl_attribute_reads.json").read_text())["hgst_hus726060_sas"]
    collector, _ = _tiered(monkeypatch)
    monkeypatch.setattr(smartctl_telemetry.smartctl, "full_read", lambda _d, _a: full)
    monkeypatch.setattr(smartctl_telemetry.smartctl, "attributes_and_health", lambda _d, _a, logs=(): attrs)
    state = collector._drive_states["g1"]
    collector._run_snapshot(state, 0)
    after_full = state.snapshot.telemetry.signals
    assert (after_full.pending, after_full.link_errors) == (108, 57)
    score = state.snapshot.health.health_pct

    # The plain attribute read has no background scan or phy pages.
    collector._run_telemetry(state, 10, full=False)
    signals = state.snapshot.telemetry.signals
    assert (signals.pending, signals.link_errors) == (108, 57)
    assert signals.power_on_hours == attrs["power_on_time"]["hours"]      # its own values still win
    assert state.snapshot.health.health_pct == score                       # judged on the carried values too


def test_a_full_read_puts_off_both_scheduled_reads(monkeypatch):
    collector, _ = _tiered(monkeypatch)
    collector._schedules["g1"].update(telemetry=1500.0, snapshot=2000.0)
    collector.capture_smart("g1")
    sched = collector._schedules["g1"]
    import time
    now = time.time()
    assert sched["telemetry"] >= now + 0.5 * 300 and sched["snapshot"] >= now + 0.5 * 14400


def test_the_scheduled_full_read_reads_and_saves(monkeypatch):
    collector, reads = _tiered(monkeypatch)
    collector._schedules["g1"]["snapshot"] = 0
    collector._last_io_at["g1"] = 0.0  # idle: a full read runs anyway
    assert _run(collector, "snapshot", 1000.0)
    assert reads.full == 1
    assert db.get_latest_raw_snapshot("g1") is not None


def test_probe_button_does_a_full_read_of_an_idle_drive(monkeypatch):
    collector, reads = _tiered(monkeypatch)
    collector._last_io_at["g1"] = 0.0
    collector._schedules["g1"]["telemetry"] = 10**10
    assert collector.trigger_poll(["g1"])
    assert reads.full == 1 and reads.attributes == []
    assert db.get_latest_raw_snapshot("g1") is not None


def test_a_restart_carries_on_from_the_saved_snapshot_without_reading(monkeypatch):
    from drives.collector import drive_collector
    monkeypatch.setattr(drive_collector, "resolve_block_device", lambda _serial: None)
    before, reads = _tiered(monkeypatch)
    saved = before.capture_smart("g1")

    after = _make_collector(activity_window=60)
    descriptor = DriveDescriptor("/dev/sdz", "scsi", "/dev/sdz")
    now = _epoch(saved["captured_at"]) + 60
    after._register_drive("g1", descriptor, DriveTraits(drive_type=DriveType.SAS), [descriptor], set(), now)

    state = after._drive_states["g1"]
    assert asdict_signals(state) == saved["signals"]
    # Judged again from the restored signals, as it was before the restart.
    assert state.snapshot.health == before._drive_states["g1"].snapshot.health
    assert state.snapshot.extras["self_test_log"]
    assert after._latest_snapshots["g1"]["snapshot_id"] == saved["snapshot_id"]
    sched = after._schedules["g1"]
    assert sched["snapshot"] == _epoch(saved["captured_at"]) + 14400
    assert sched["telemetry"] > now
    assert reads.full == 1  # only the one before the restart


def test_a_drive_with_no_saved_snapshot_is_read_at_once(monkeypatch):
    from drives.collector import drive_collector
    monkeypatch.setattr(drive_collector, "resolve_block_device", lambda _serial: None)
    db.init()
    collector = _make_collector(activity_window=60)
    descriptor = DriveDescriptor("/dev/sdz", "scsi", "/dev/sdz")
    collector._register_drive("g1", descriptor, DriveTraits(), [descriptor], set(), 1000.0)
    assert collector._schedules["g1"]["snapshot"] == 1000.0
    assert collector._drive_states["g1"].snapshot.telemetry.last_polled_at is None


def asdict_signals(state):
    from dataclasses import asdict
    return asdict(state.snapshot.telemetry.signals)


def test_last_full_read_at_follows_the_latest_saved_snapshot(monkeypatch):
    collector, _ = _tiered(monkeypatch)
    assert collector.last_full_read_at("g1") is None
    state = collector._drive_states["g1"]
    collector._run_telemetry(state, 0, full=False)
    assert collector.last_full_read_at("g1") is None  # an attribute read isn't one
    saved = collector.capture_smart("g1")
    assert collector.last_full_read_at("g1") == saved["captured_at"]
