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
                "drive_heartbeats", "drive_vitals", "drive_vitals_rollup", "drive_vitals_rollup_30m", "collector_state",
                "jobs"} <= tables
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
    db.record_heartbeat("guid-1", "2026-01-01T00:00:00", 30)
    db.record_heartbeat("guid-1", "2026-06-01T00:00:00", 31)
    db.prune_history("2026-03-01T00:00:00")
    with db._connection() as conn:
        remaining = conn.execute("SELECT captured_at FROM drive_heartbeats").fetchall()
    assert remaining == [("2026-06-01T00:00:00",)]


def _signal_rows():
    with db._connection() as conn:
        return conn.execute(
            "SELECT drive_guid, captured_at, signal, value FROM drive_signals ORDER BY drive_guid, signal, captured_at"
        ).fetchall()


def test_record_signals_writes_only_values_that_changed():
    db.record_signals("guid-1", "2026-01-01T00:00:00", {"reallocated": 0, "smart_passed": True, "pending": None})
    db.record_signals("guid-1", "2026-01-01T00:05:00", {"reallocated": 0, "smart_passed": True, "pending": None})
    db.record_signals("guid-1", "2026-01-01T00:10:00", {"reallocated": 2, "smart_passed": True, "pending": 1})
    db.record_signals("guid-2", "2026-01-01T00:10:00", {"reallocated": 2})   # another drive's own history
    assert _signal_rows() == [
        ("guid-1", "2026-01-01T00:10:00", "pending", 1.0),
        ("guid-1", "2026-01-01T00:00:00", "reallocated", 0.0),
        ("guid-1", "2026-01-01T00:10:00", "reallocated", 2.0),
        ("guid-1", "2026-01-01T00:00:00", "smart_passed", 1.0),
        ("guid-2", "2026-01-01T00:10:00", "reallocated", 2.0),
    ]


def test_record_signals_writes_a_value_again_when_it_changes_back():
    for at, v in (("00:00", 0), ("00:05", 3), ("00:10", 0)):
        db.record_signals("guid-1", f"2026-01-01T{at}:00", {"pending": v})
    assert [r[3] for r in _signal_rows()] == [0.0, 3.0, 0.0]


def test_init_compacts_signals_stored_on_every_poll_once():
    with db._connection() as conn:
        conn.executemany(
            "INSERT INTO drive_signals (drive_guid, captured_at, signal, value) VALUES (?, ?, ?, ?)",
            [("guid-1", f"2026-01-01T00:0{m}:00", "pending", v) for m, v in enumerate([0, 0, 3, 3, 0])]
            + [("guid-2", "2026-01-01T00:00:00", "pending", 0)],
        )
        conn.execute("PRAGMA user_version = 0")
    db.init()
    assert _signal_rows() == [
        ("guid-1", "2026-01-01T00:00:00", "pending", 0.0),
        ("guid-1", "2026-01-01T00:02:00", "pending", 3.0),
        ("guid-1", "2026-01-01T00:04:00", "pending", 0.0),
        ("guid-2", "2026-01-01T00:00:00", "pending", 0.0),
    ]
    with db._connection() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 1


def test_prune_history_keeps_the_signal_value_still_current_at_the_cutoff():
    db.record_signals("guid-1", "2026-01-01T00:00:00", {"reallocated": 1, "pending": 0})
    db.record_signals("guid-1", "2026-02-01T00:00:00", {"reallocated": 4, "pending": 0})
    db.record_signals("guid-1", "2026-06-01T00:00:00", {"reallocated": 9, "pending": 0})
    db.prune_history("2026-03-01T00:00:00")
    assert _signal_rows() == [
        ("guid-1", "2026-01-01T00:00:00", "pending", 0.0),       # never changed: its only row stays
        ("guid-1", "2026-02-01T00:00:00", "reallocated", 4.0),   # the value current at the cutoff
        ("guid-1", "2026-06-01T00:00:00", "reallocated", 9.0),
    ]


def _vitals(guid, captured_at, temp_c, read_bps=None, write_bps=None):
    io = DriveIOActivity(read_iops=1.0 if read_bps is not None else None,
                         write_iops=1.0 if write_bps is not None else None,
                         read_bytes_per_sec=read_bps, write_bytes_per_sec=write_bps,
                         busy_pct=10.0 if read_bps is not None else None)
    db.record_vitals(guid, captured_at, temp_c=temp_c, temp_source="hwmon", io=io)


def _rollup_rows():
    with db._connection() as conn:
        return conn.execute(
            "SELECT drive_guid, captured_at, temp_n, temp_min, temp_avg, temp_max, io_n, read_bps_avg, write_bps_avg"
            " FROM drive_vitals_rollup ORDER BY drive_guid, captured_at"
        ).fetchall()


def test_rollup_vitals_averages_each_drive_minute_over_its_non_null_samples():
    _vitals("guid-1", "2026-01-01T00:00:05.120000", 30, read_bps=100.0, write_bps=0.0)
    _vitals("guid-1", "2026-01-01T00:00:15.120000", 32, read_bps=300.0, write_bps=0.0)
    _vitals("guid-1", "2026-01-01T00:00:25.120000", None)           # no reading this tick
    _vitals("guid-1", "2026-01-01T00:01:05.120000", 40, read_bps=0.0, write_bps=50.0)
    _vitals("guid-2", "2026-01-01T00:00:59.999999", 50)

    assert db.rollup_vitals("2026-01-01T00:02:00") == 3
    assert _rollup_rows() == [
        ("guid-1", "2026-01-01T00:00:00", 2, 30, 31.0, 32, 2, 200.0, 0.0),
        ("guid-1", "2026-01-01T00:01:00", 1, 40, 40.0, 40, 1, 0.0, 50.0),
        ("guid-2", "2026-01-01T00:00:00", 1, 50, 50.0, 50, 0, None, None),
    ]
    assert db.get_last_vitals_rollup_at() == "2026-01-01T00:01:00"


def test_rollup_vitals_leaves_out_the_end_minute_and_re_rolls_a_minute_in_place():
    _vitals("guid-1", "2026-01-01T00:00:05", 30)
    _vitals("guid-1", "2026-01-01T00:01:05", 40)
    db.rollup_vitals("2026-01-01T00:01:00")
    assert [r[1] for r in _rollup_rows()] == ["2026-01-01T00:00:00"]

    # A late sample for minute 00:00 lands; re-rolling from that minute updates its row.
    _vitals("guid-1", "2026-01-01T00:00:55", 34)
    db.rollup_vitals("2026-01-01T00:02:00", start_iso="2026-01-01T00:00:00")
    assert [(r[1], r[2], r[4]) for r in _rollup_rows()] == [
        ("2026-01-01T00:00:00", 2, 32.0),
        ("2026-01-01T00:01:00", 1, 40.0),
    ]


def test_rollup_vitals_30m_weights_each_minute_by_its_samples():
    _vitals("guid-1", "2026-01-01T00:29:10", 30, read_bps=100.0, write_bps=0.0)
    _vitals("guid-1", "2026-01-01T00:29:20", 30, read_bps=100.0, write_bps=0.0)
    _vitals("guid-1", "2026-01-01T00:29:30", 30, read_bps=100.0, write_bps=0.0)
    _vitals("guid-1", "2026-01-01T00:05:00", 34, read_bps=500.0, write_bps=0.0)
    _vitals("guid-1", "2026-01-01T00:31:00", 40)                  # next half-hour
    db.rollup_vitals("2026-01-01T01:00:00")

    assert db.rollup_vitals_30m("2026-01-01T01:00:00") == 2
    with db._connection() as conn:
        rows = conn.execute(
            "SELECT captured_at, temp_n, temp_min, temp_avg, temp_max, io_n, read_bps_avg"
            " FROM drive_vitals_rollup_30m ORDER BY captured_at"
        ).fetchall()
    assert rows == [
        ("2026-01-01T00:00:00", 4, 30, 31.0, 34, 4, 200.0),
        ("2026-01-01T00:30:00", 1, 40, 40.0, 40, 0, None),   # no IO reading that minute
    ]


def test_get_last_vitals_rollup_at_is_none_before_any_rollup():
    assert db.get_last_vitals_rollup_at() is None


def test_prune_history_keeps_raw_vitals_on_their_own_shorter_window():
    for day in ("2026-01-01", "2026-02-01", "2026-03-01"):
        _vitals("guid-1", f"{day}T00:00:00", 30)
    db.rollup_vitals("2026-04-01T00:00:00")
    db.prune_history("2026-01-15T00:00:00", raw_vitals_cutoff_iso="2026-02-15T00:00:00")
    with db._connection() as conn:
        raw = conn.execute("SELECT captured_at FROM drive_vitals").fetchall()
    assert raw == [("2026-03-01T00:00:00",)]
    assert [r[1] for r in _rollup_rows()] == ["2026-02-01T00:00:00", "2026-03-01T00:00:00"]


def test_prune_history_never_keeps_raw_vitals_longer_than_the_history_window():
    _vitals("guid-1", "2026-01-01T00:00:00", 30)
    db.prune_history("2026-02-01T00:00:00", raw_vitals_cutoff_iso="2025-01-01T00:00:00")
    with db._connection() as conn:
        assert conn.execute("SELECT count(*) FROM drive_vitals").fetchone()[0] == 0


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


def _finished_job(job_id, guid="guid-1", status=JobStatus.COMPLETED, operation="dd_read_test",
                  category="Scan", finished=datetime(2026, 1, 1)):
    return Job(id=job_id, drive_guid=guid, operation=operation, category=category, params={},
               status=status, created_at=finished, started_at=finished, finished_at=finished)


def test_job_history_across_drives_newest_finished_first():
    db.record_job(_finished_job("a", "guid-1", finished=datetime(2026, 1, 2)))
    db.record_job(_finished_job("b", "guid-2", finished=datetime(2026, 1, 3)))
    db.record_job(_finished_job("c", "guid-3", finished=datetime(2026, 1, 1)))
    assert [r["id"] for r in db.get_job_history()] == ["b", "a", "c"]
    assert [r["id"] for r in db.get_job_history(["guid-1", "guid-3"])] == ["a", "c"]


def test_job_history_filters_by_since_status_operation_and_category():
    db.record_job(_finished_job("old", finished=datetime(2026, 1, 1)))
    db.record_job(_finished_job("failed", status=JobStatus.FAILED, finished=datetime(2026, 1, 10)))
    db.record_job(_finished_job("short", operation="smart_self_test_short", category="Test", finished=datetime(2026, 1, 11)))
    db.record_job(_finished_job("debug", operation="debug_sleep", category="Debug", finished=datetime(2026, 1, 12)))

    assert [r["id"] for r in db.get_job_history(since="2026-01-05T00:00:00")] == ["debug", "short", "failed"]
    assert [r["id"] for r in db.get_job_history(statuses=["failed"])] == ["failed"]
    assert [r["id"] for r in db.get_job_history(operations=["smart_self_test_short"])] == ["short"]
    assert "debug" not in [r["id"] for r in db.get_job_history(exclude_categories=["Debug"])]
    assert db.get_job_history(statuses=[]) == []


def test_job_history_since_leaves_out_unfinished_jobs():
    db.record_job(Job(id="queued", drive_guid="guid-1", operation="dd_read_test", category="Scan",
                      params={}, created_at=datetime(2026, 1, 20)))
    db.record_job(_finished_job("done", finished=datetime(2026, 1, 10)))
    assert [r["id"] for r in db.get_job_history(since="2026-01-05T00:00:00")] == ["done"]
    assert [r["id"] for r in db.get_job_history()] == ["queued", "done"]


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


def test_migration_adds_the_queue_position_column(isolated_data_dir):
    with db._connection() as conn:
        conn.execute("DROP TABLE jobs")
        conn.execute("""CREATE TABLE jobs (id TEXT PRIMARY KEY, drive_guid TEXT NOT NULL, operation TEXT NOT NULL,
                        category TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
                        error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, reattach_json TEXT,
                        smart_before_json TEXT, smart_after_json TEXT)""")
    db.init()
    db.record_job(Job(id="q", drive_guid="g", operation="dd_read_test", category="Scan", params={}, queue_position=3))
    assert db.get_active_jobs()[0]["queue_position"] == 3


def test_active_jobs_come_back_in_queue_order_then_creation_order():
    def queued(job_id, day, pos):
        db.record_job(Job(id=job_id, drive_guid="g", operation="dd_read_test", category="Scan", params={},
                          created_at=datetime(2026, 1, day), queue_position=pos))
    queued("first-created", 1, 2)
    queued("moved-to-front", 2, 0)
    queued("from-older-version", 3, None)   # rows saved before queue_position existed
    queued("second", 4, 1)
    db.set_queue_positions({"second": 1})
    assert [r["id"] for r in db.get_active_jobs()] == ["moved-to-front", "second", "first-created", "from-older-version"]
