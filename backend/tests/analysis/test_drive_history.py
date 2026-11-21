import json
from datetime import datetime

import pytest

from analysis.drive_history import build_history
from database import db
from drives.drive_models import DriveIOActivity
from jobs.job_models import Job, JobStatus

NOW = datetime(2026, 1, 2, 12, 0, 30)   # 24h range -> 5-minute buckets from 2026-01-01T12:00


@pytest.fixture(autouse=True)
def _init_db(isolated_data_dir):
    db.init()


def _vitals(guid, at, temp, read_bps=0.0, write_bps=0.0):
    io = DriveIOActivity(read_iops=0.0, write_iops=0.0, read_bytes_per_sec=read_bps,
                         write_bytes_per_sec=write_bps, busy_pct=0.0)
    db.record_vitals(guid, at, temp_c=temp, temp_source="hwmon", io=io)


def _signals(guid, at, **values):
    base = {"smart_passed": True, "reallocated": 0, "pending": 0, "uncorrected": 0, "crc_errors": 0,
            "power_on_hours": 1000, "temp": 30}
    db.record_signals(guid, at, {**base, **values})


def test_vitals_are_averaged_into_aligned_buckets_weighted_by_samples():
    # Two minutes in the bucket starting 12:00: one with 2 samples, one with 1.
    _vitals("g1", "2026-01-02T08:00:05", 30, read_bps=100.0)
    _vitals("g1", "2026-01-02T08:00:15", 30, read_bps=100.0)
    _vitals("g1", "2026-01-02T08:03:05", 36, read_bps=400.0)
    _vitals("g1", "2026-01-02T08:05:05", 40, write_bps=50.0)    # next bucket
    _vitals("g1", "2026-01-01T11:00:00", 99)                    # before the range
    db.rollup_vitals("2026-01-02T12:00:00")

    h = build_history(["g1"], "24h", now=NOW)

    assert (h["start"], h["bucket_seconds"]) == ("2026-01-01T12:00:00", 300)
    assert h["drives"]["g1"]["vitals"] == {
        "t": ["2026-01-02T08:00:00", "2026-01-02T08:05:00"],
        "temp_avg": [32.0, 40.0], "temp_min": [30, 40], "temp_max": [36, 40],
        "read_bps": [200.0, 0.0], "write_bps": [0.0, 50.0], "busy_pct": [0.0, 0.0],
    }


def test_signals_are_sent_only_where_they_change_with_the_carried_in_value_at_the_start():
    _signals("g1", "2026-01-01T06:00:00", reallocated=3)         # before the range
    _signals("g1", "2026-01-01T13:00:00", reallocated=3)
    _signals("g1", "2026-01-01T14:00:00", reallocated=3, power_on_hours=1001)
    _signals("g1", "2026-01-02T09:00:00", reallocated=5)

    h = build_history(["g1"], "24h", now=NOW)
    s = h["drives"]["g1"]["signals"]

    assert s["reallocated"] == [
        {"t": "2026-01-01T12:00:00", "value": 3},
        {"t": "2026-01-02T09:00:00", "value": 5},
    ]
    assert s["smart_passed"] == [{"t": "2026-01-01T12:00:00", "value": True}]
    assert "temp" not in s and "power_on_hours" not in s


def test_health_is_scored_per_poll_and_sent_only_when_it_changes():
    _signals("g1", "2026-01-01T13:00:00")
    _signals("g1", "2026-01-01T14:00:00", temp=31)                  # signal moves, score doesn't
    _signals("g1", "2026-01-01T15:00:00", reallocated=1)            # 79 Degraded
    _signals("g1", "2026-01-01T16:00:00", reallocated=1, smart_passed=False)   # the drive says it's failing

    health = build_history(["g1"], "24h", now=NOW)["drives"]["g1"]["health"]

    assert [(p["t"], p["health_pct"], p["health_status"]) for p in health] == [
        ("2026-01-01T13:00:00", 100, "Healthy"),
        ("2026-01-01T15:00:00", 79, "Degraded"),
        ("2026-01-01T16:00:00", 9, "Critical"),
    ]


def test_each_health_point_carries_the_factors_that_made_it():
    _signals("g1", "2026-01-01T13:00:00")
    _signals("g1", "2026-01-01T15:00:00", reallocated=1)

    health = build_history(["g1"], "24h", now=NOW)["drives"]["g1"]["health"]

    assert health[0]["factors"] == [] and health[0]["floor"] is None
    [factor] = [f for f in health[1]["factors"] if f["signal"] == "reallocated"]
    assert (factor["role"], factor["points"]) == ("start", 79)


def test_first_readings_are_each_signals_earliest_reported_value_in_or_before_the_range():
    _signals("g1", "2026-01-01T06:00:00")                                    # before the range
    db.record_signals("g1", "2026-01-02T09:00:00", {"link_errors": 57})
    db.record_signals("g1", "2026-01-02T13:00:00", {"pending": 2})          # after the range

    first = build_history(["g1"], "24h", now=NOW)["drives"]["g1"]["first_readings"]

    assert first["reallocated"] == "2026-01-01T06:00:00"
    assert first["link_errors"] == "2026-01-02T09:00:00"
    assert first["pending"] == "2026-01-01T06:00:00"
    assert "data_read" not in first


def test_drives_are_kept_apart_and_unknown_drives_come_back_empty():
    _signals("g1", "2026-01-01T13:00:00", reallocated=1)
    _signals("g2", "2026-01-01T13:00:00", reallocated=7)

    h = build_history(["g1", "g2", "nope"], "24h", now=NOW)

    assert h["drives"]["g1"]["signals"]["reallocated"] == [{"t": "2026-01-01T13:00:00", "value": 1}]
    assert h["drives"]["g2"]["signals"]["reallocated"] == [{"t": "2026-01-01T13:00:00", "value": 7}]
    assert h["drives"]["nope"]["vitals"]["t"] == []
    assert (h["drives"]["nope"]["signals"], h["drives"]["nope"]["health"]) == ({}, [])


def _job(id, guid, started, finished, status=JobStatus.COMPLETED):
    db.record_job(Job(
        id=id, drive_guid=guid, operation="dd_read_test", category="Test", params={},
        status=status, created_at=started or datetime(2026, 1, 1), started_at=started, finished_at=finished,
    ))


def test_jobs_overlapping_the_range_are_included_with_extra_fields():
    _job("ended-before", "g1", datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9))
    _job("spans-start", "g1", datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 13))
    _job("running", "g1", datetime(2026, 1, 2, 11), None, status=JobStatus.RUNNING)
    _job("queued", "g1", None, None, status=JobStatus.QUEUED)
    _job("other-drive", "g2", datetime(2026, 1, 2, 1), datetime(2026, 1, 2, 2))

    h = build_history(["g1"], "24h", now=NOW, describe_job=lambda row: {"name": row["operation"].upper()})

    assert [j["id"] for j in h["jobs"]] == ["spans-start", "running"]
    assert h["jobs"][1]["finished_at"] is None
    assert h["jobs"][0]["name"] == "DD_READ_TEST"


def test_thresholds_are_published_with_the_history():
    t = build_history(["g1"], "1h", now=NOW)["thresholds"]
    assert t["signals"]["temp"] == {"warn_gte": 46, "crit_gte": None}
    assert t["health"] == {"healthy_gte": 95, "aging_gte": 80, "degraded_gte": 40, "failing_gte": 15}


def test_ranges_of_a_week_or_more_read_the_30_minute_rollup():
    _vitals("g1", "2026-01-02T08:10:00", 30)
    _vitals("g1", "2026-01-02T08:50:00", 40)
    db.rollup_vitals("2026-01-02T12:00:00")
    assert build_history(["g1"], "7d", now=NOW)["drives"]["g1"]["vitals"]["t"] == []   # 30m tier not rolled yet

    db.rollup_vitals_30m("2026-01-02T12:00:00")
    h = build_history(["g1"], "7d", now=NOW)
    assert h["bucket_seconds"] == 1800
    v = h["drives"]["g1"]["vitals"]
    assert (v["t"], v["temp_avg"]) == (["2026-01-02T08:00:00", "2026-01-02T08:30:00"], [30.0, 40.0])


def test_temperature_counts_toward_health_by_its_highest_value_per_bucket():
    _signals("g1", "2026-01-01T06:00:00", temp=40)                      # carried in
    _signals("g1", "2026-01-02T08:01:00", temp=47)                      # bucket 08:00 peaks at 47
    _signals("g1", "2026-01-02T08:02:00", temp=41)
    _signals("g1", "2026-01-02T08:06:00", temp=41)                      # next bucket is back under 45

    d = build_history(["g1"], "24h", now=NOW)["drives"]["g1"]

    assert [(h["t"], h["health_pct"]) for h in d["health"]] == [
        ("2026-01-01T12:00:00", 100),
        ("2026-01-02T08:00:00", 99),       # temp warn: 47°C costs a point for the bucket holding it
        ("2026-01-02T08:05:00", 100),
    ]
    assert "temp" not in d["signals"]


def _full_read(guid, at, attributes=(), self_test_log=()):
    report = {"smart_attributes": list(attributes), "self_test_log": list(self_test_log)}
    return db.record_raw_snapshot(guid, at, "smartctl_telemetry", json.dumps(report))


_FAILING_NOW = {"key": "ata_3", "label": "Spin Up Time", "value": "0", "drive_report": "failed"}


def test_each_point_is_scored_with_the_latest_full_reads_facts():
    _signals("g1", "2026-01-01T06:00:00")
    _full_read("g1", "2026-01-01T06:00:00")                             # carried in, clean
    _signals("g1", "2026-01-01T13:00:00", reallocated=1)
    _full_read("g1", "2026-01-01T18:00:00", [_FAILING_NOW])             # no signal changed with it
    _full_read("g1", "2026-01-02T00:00:00")                             # clean again

    health = build_history(["g1"], "24h", now=NOW)["drives"]["g1"]["health"]

    assert [(p["t"], p["health_status"]) for p in health] == [
        ("2026-01-01T12:00:00", "Healthy"),
        ("2026-01-01T13:00:00", "Degraded"),
        ("2026-01-01T18:00:00", "Critical"),
        ("2026-01-02T00:00:00", "Degraded"),
    ]


def test_a_full_read_from_before_the_range_counts_from_the_start():
    _signals("g1", "2026-01-01T06:00:00")
    _full_read("g1", "2026-01-01T06:00:00", [_FAILING_NOW])

    health = build_history(["g1"], "24h", now=NOW)["drives"]["g1"]["health"]

    assert [(p["t"], p["health_status"]) for p in health] == [("2026-01-01T12:00:00", "Critical")]


def test_a_full_read_before_any_signals_adds_no_point():
    _full_read("g1", "2026-01-01T13:00:00", [_FAILING_NOW])
    assert build_history(["g1"], "24h", now=NOW)["drives"]["g1"]["health"] == []
