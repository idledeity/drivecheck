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


# ---------------------------------------------------------------------------
# Job SMART snapshots
# ---------------------------------------------------------------------------

_BEFORE = {"snapshot_id": 7, "captured_at": "2026-01-01T00:00:00", "signals": {"reallocated": 0},
           "reused": False}
_AFTER_FAILED = {"captured_at": "2026-01-01T05:00:00", "error": "smartctl timed out"}


def _job_with_snapshots(before=_BEFORE, after=_AFTER_FAILED, job_id="job-s"):
    return Job(
        id=job_id, drive_guid="guid-1", operation="dd_read_test", category="Scan", params={},
        status=JobStatus.COMPLETED, created_at=datetime(2026, 1, 1),
        smart_before=before, smart_after=after,
    )


def test_get_job_smart_returns_the_summaries():
    db.record_job(_job_with_snapshots())
    assert db.get_job_smart("job-s") == (_BEFORE, _AFTER_FAILED)
    assert db.get_job_smart("no-such-job") is None


def test_job_history_rows_carry_the_summaries():
    db.record_job(_job_with_snapshots())
    [row] = db.get_job_history("guid-1")
    assert row["smart_before_json"] is not None and row["smart_after_json"] is not None


def test_get_raw_snapshot_by_id():
    snapshot_id = db.record_raw_snapshot("guid-1", "2026-01-01T00:00:00", "smartctl_telemetry", '{"a": 1}')
    assert db.get_raw_snapshot(snapshot_id)["raw_json"] == '{"a": 1}'
    assert db.get_raw_snapshot(snapshot_id + 1000) is None


def _old_snapshots():
    """Two raw snapshots past the cutoff; only the first is referenced by a job."""
    referenced = db.record_raw_snapshot("guid-1", "2025-01-01T00:00:00", "smartctl_telemetry", "{}")
    unreferenced = db.record_raw_snapshot("guid-1", "2025-01-02T00:00:00", "smartctl_telemetry", "{}")
    db.record_job(_job_with_snapshots(before={**_BEFORE, "snapshot_id": referenced}, after=None))
    return referenced, unreferenced


def test_prune_keeps_snapshots_referenced_by_jobs():
    referenced, unreferenced = _old_snapshots()
    db.prune_history("2026-01-01T00:00:00", keep_job_snapshots=True)
    assert db.get_raw_snapshot(referenced) is not None
    assert db.get_raw_snapshot(unreferenced) is None


def test_prune_can_let_job_snapshots_expire_with_the_rest():
    referenced, unreferenced = _old_snapshots()
    db.prune_history("2026-01-01T00:00:00", keep_job_snapshots=False)
    assert db.get_raw_snapshot(referenced) is None
    assert db.get_raw_snapshot(unreferenced) is None
    assert db.get_job_smart("job-s")[0]["signals"] == {"reallocated": 0}  # condensed values survive


def test_migration_adds_snapshot_columns_to_an_existing_jobs_table(isolated_data_dir):
    with db._connection() as conn:
        conn.execute("DROP TABLE jobs")
        conn.execute("""CREATE TABLE jobs (id TEXT PRIMARY KEY, drive_guid TEXT NOT NULL, operation TEXT NOT NULL,
                        category TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
                        error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, reattach_json TEXT)""")
    db.init()
    db.record_job(_job_with_snapshots())
    assert db.get_job_smart("job-s") == (_BEFORE, _AFTER_FAILED)
