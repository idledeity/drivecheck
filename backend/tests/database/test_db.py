from datetime import datetime

import pytest

from database import db
from drives.drive_models import DriveIOActivity
from jobs.job_models import Job, JobStatus


@pytest.fixture(autouse=True)
def _init_db(isolated_data_dir):
    db.init()


def test_init_creates_schema_and_enables_wal():
    with db._connection() as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"drive_records", "drive_signals", "drive_raw_snapshots",
                "drive_heartbeats", "drive_vitals", "collector_state", "jobs"} <= tables
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"


def test_get_drive_record_missing_returns_none():
    assert db.get_drive_record("nonexistent-guid") is None


def test_upsert_then_get_drive_record_roundtrips():
    db.upsert_drive_record(
        guid="guid-1", serial="SN1", model="ModelX",
        capacity_bytes=1000, drive_type="HDD", first_seen="2026-01-01T00:00:00",
    )
    record = db.get_drive_record("guid-1")
    assert record["guid"] == "guid-1"
    assert record["serial"] == "SN1"
    assert record["model"] == "ModelX"
    assert record["capacity_bytes"] == 1000
    assert record["drive_type"] == "HDD"
    assert record["first_seen"] == "2026-01-01T00:00:00"
    assert record["label"] is None


def test_upsert_drive_record_updates_identity_but_preserves_first_seen():
    db.upsert_drive_record(
        guid="guid-1", serial="SN1", model="ModelX",
        capacity_bytes=1000, drive_type="HDD", first_seen="2026-01-01T00:00:00",
    )
    db.upsert_drive_record(
        guid="guid-1", serial="SN2", model="ModelY",
        capacity_bytes=2000, drive_type="SSD", first_seen="2026-06-01T00:00:00",
    )
    record = db.get_drive_record("guid-1")
    assert record["serial"] == "SN2"
    assert record["model"] == "ModelY"
    assert record["capacity_bytes"] == 2000
    assert record["drive_type"] == "SSD"
    assert record["first_seen"] == "2026-01-01T00:00:00"


def test_set_drive_label():
    db.upsert_drive_record(
        guid="guid-1", serial="SN1", model="ModelX",
        capacity_bytes=1000, drive_type="HDD", first_seen="2026-01-01T00:00:00",
    )
    db.set_drive_label("guid-1", "Backup Drive")
    assert db.get_drive_record("guid-1")["label"] == "Backup Drive"


def test_record_signals_skips_none_values():
    db.record_signals("guid-1", "2026-01-01T00:00:00", {"temp": 35, "reallocated": None})
    with db._connection() as conn:
        rows = conn.execute("SELECT signal, value FROM drive_signals WHERE drive_guid = ?", ("guid-1",)).fetchall()
    assert rows == [("temp", 35)]


def test_record_signals_with_no_non_null_values_writes_nothing():
    db.record_signals("guid-1", "2026-01-01T00:00:00", {"reallocated": None})
    with db._connection() as conn:
        count = conn.execute("SELECT COUNT(*) FROM drive_signals").fetchone()[0]
    assert count == 0


def test_record_and_get_latest_raw_snapshot():
    db.record_raw_snapshot("guid-1", "2026-01-01T00:00:00", "smartctl", '{"a": 1}')
    row_id = db.record_raw_snapshot("guid-1", "2026-01-02T00:00:00", "smartctl", '{"a": 2}')
    latest = db.get_latest_raw_snapshot("guid-1")
    assert latest["id"] == row_id
    assert latest["raw_json"] == '{"a": 2}'


def test_get_latest_raw_snapshot_missing_returns_none():
    assert db.get_latest_raw_snapshot("nonexistent-guid") is None


def test_record_vitals():
    io = DriveIOActivity(read_iops=1.0, write_iops=2.0, read_bytes_per_sec=3.0,
                          write_bytes_per_sec=4.0, busy_pct=5.0)
    db.record_vitals("guid-1", "2026-01-01T00:00:00", temp_c=40, temp_source="smart", io=io)
    with db._connection() as conn:
        conn.row_factory = None
        row = conn.execute("SELECT temp_c, temp_source, read_iops FROM drive_vitals").fetchone()
    assert row == (40, "smart", 1.0)


def test_prune_history_deletes_rows_before_cutoff():
    db.record_signals("guid-1", "2026-01-01T00:00:00", {"temp": 1})
    db.record_signals("guid-1", "2026-06-01T00:00:00", {"temp": 2})
    db.prune_history("2026-03-01T00:00:00")
    with db._connection() as conn:
        remaining = conn.execute("SELECT captured_at FROM drive_signals").fetchall()
    assert remaining == [("2026-06-01T00:00:00",)]


def test_last_pruned_at_roundtrips():
    assert db.get_last_pruned_at() is None
    db.set_last_pruned_at("2026-01-01T00:00:00")
    assert db.get_last_pruned_at() == "2026-01-01T00:00:00"
    db.set_last_pruned_at("2026-02-01T00:00:00")
    assert db.get_last_pruned_at() == "2026-02-01T00:00:00"


def test_record_job_and_get_job_history():
    job = Job(
        id="job-1", drive_guid="guid-1", operation="dd_read_test", category="Test",
        params={"blocksize": 4096}, status=JobStatus.COMPLETED, result={"ok": True},
        created_at=datetime(2026, 1, 1), started_at=datetime(2026, 1, 1, 0, 1),
        finished_at=datetime(2026, 1, 1, 0, 2),
    )
    db.record_job(job)
    history = db.get_job_history("guid-1")
    assert len(history) == 1
    assert history[0]["id"] == "job-1"
    assert history[0]["status"] == "completed"


def test_get_job_history_respects_limit_and_ordering():
    for i in range(3):
        db.record_job(Job(
            id=f"job-{i}", drive_guid="guid-1", operation="dd_read_test", category="Test",
            params={}, status=JobStatus.COMPLETED,
            created_at=datetime(2026, 1, i + 1),
        ))
    history = db.get_job_history("guid-1", limit=2)
    assert [row["id"] for row in history] == ["job-2", "job-1"]
