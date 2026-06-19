"""
db.py — SQLite persistence layer for drivecheck.

Raw sqlite3, no ORM. WAL mode is enabled once at init so the collector's
writes don't block API request reads. Every call opens its own short-lived
connection — sqlite3 connections aren't safe to share across threads, and
the access patterns here are infrequent enough that connection overhead
doesn't matter.
"""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from config import CONFIG
from drive_models import DriveIOActivity
from job_models import Job

_DB_PATH = (Path(__file__).parent.parent / CONFIG["data"]["dir"] / "drivecheck.db").resolve()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS drive_records (
    guid           TEXT PRIMARY KEY,
    serial         TEXT,
    model          TEXT,
    capacity_bytes INTEGER,
    drive_type     TEXT,
    first_seen     TEXT NOT NULL,
    conflict_flag  INTEGER NOT NULL DEFAULT 0,
    label          TEXT
);

CREATE TABLE IF NOT EXISTS drive_signals (
    id          INTEGER PRIMARY KEY,
    drive_guid  TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    signal      TEXT NOT NULL,
    value       REAL
);

CREATE INDEX IF NOT EXISTS idx_drive_signals_lookup
    ON drive_signals (drive_guid, signal, captured_at);

CREATE TABLE IF NOT EXISTS drive_raw_snapshots (
    id          INTEGER PRIMARY KEY,
    drive_guid  TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    probe       TEXT NOT NULL,
    raw_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drive_raw_snapshots_lookup
    ON drive_raw_snapshots (drive_guid, captured_at);

CREATE TABLE IF NOT EXISTS drive_heartbeats (
    id              INTEGER PRIMARY KEY,
    drive_guid      TEXT NOT NULL,
    captured_at     TEXT NOT NULL,
    temp_c          INTEGER,
    raw_snapshot_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drive_heartbeats_lookup
    ON drive_heartbeats (drive_guid, captured_at);

CREATE TABLE IF NOT EXISTS drive_vitals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    drive_guid          TEXT NOT NULL,
    captured_at         TEXT NOT NULL,
    temp_c              INTEGER,
    temp_source         TEXT,
    read_iops           REAL,
    write_iops          REAL,
    read_bytes_per_sec  REAL,
    write_bytes_per_sec REAL,
    busy_pct            REAL
);

CREATE INDEX IF NOT EXISTS idx_drive_vitals_guid_captured
    ON drive_vitals (drive_guid, captured_at);

-- Single-row table of collector bookkeeping that must survive restarts.
CREATE TABLE IF NOT EXISTS collector_state (
    last_pruned_at TEXT
);

-- One row per terminal job (completed/failed/cancelled). Active job state
-- lives in JobRegistry; this table is for future History tab queries.
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    drive_guid  TEXT NOT NULL,
    operation   TEXT NOT NULL,
    category    TEXT NOT NULL,
    params_json TEXT NOT NULL,
    status      TEXT NOT NULL,
    result_json TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_drive_guid ON jobs (drive_guid, created_at);
"""


@contextmanager
def _connection():
    conn = sqlite3.connect(_DB_PATH)
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init() -> None:
    """Create the database file and schema if needed, and enable WAL mode."""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply schema changes that CREATE TABLE IF NOT EXISTS can't express on existing DBs."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(drive_records)")}
    if "label" not in columns:
        conn.execute("ALTER TABLE drive_records ADD COLUMN label TEXT")


# ---------------------------------------------------------------------------
# Drive records
# ---------------------------------------------------------------------------

def get_drive_record(guid: str) -> sqlite3.Row | None:
    """Return the persisted drive record for a GUID, or None if not yet seen."""
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM drive_records WHERE guid = ?", (guid,)
        ).fetchone()


def upsert_drive_record(
    guid: str,
    serial: str | None,
    model: str | None,
    capacity_bytes: int | None,
    drive_type: str | None,
    first_seen: str,
) -> None:
    """
    Insert a drive record on first sighting, or refresh its identity fields on
    subsequent sightings. first_seen is preserved across updates.
    """
    with _connection() as conn:
        conn.execute(
            """
            INSERT INTO drive_records (guid, serial, model, capacity_bytes, drive_type, first_seen)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guid) DO UPDATE SET
                serial = excluded.serial,
                model = excluded.model,
                capacity_bytes = excluded.capacity_bytes,
                drive_type = excluded.drive_type
            """,
            (guid, serial, model, capacity_bytes, drive_type, first_seen),
        )


def set_drive_label(guid: str, label: str | None) -> None:
    """Persist a user-assigned label for a drive."""
    with _connection() as conn:
        conn.execute("UPDATE drive_records SET label = ? WHERE guid = ?", (label, guid))


# ---------------------------------------------------------------------------
# Time-series writes
# ---------------------------------------------------------------------------

def record_signals(guid: str, captured_at: str, signals: dict) -> None:
    """Write one drive_signals row per non-null signal value."""
    rows = [
        (guid, captured_at, name, value)
        for name, value in signals.items()
        if value is not None
    ]
    if not rows:
        return
    with _connection() as conn:
        conn.executemany(
            "INSERT INTO drive_signals (drive_guid, captured_at, signal, value) VALUES (?, ?, ?, ?)",
            rows,
        )


def record_heartbeat(
    guid: str,
    captured_at: str,
    temp_c: int | None,
    raw_snapshot_id: int | None = None,
) -> None:
    """Record a poll heartbeat — presence and temperature at this point in time."""
    with _connection() as conn:
        conn.execute(
            "INSERT INTO drive_heartbeats (drive_guid, captured_at, temp_c, raw_snapshot_id) VALUES (?, ?, ?, ?)",
            (guid, captured_at, temp_c, raw_snapshot_id),
        )


def record_vitals(
    guid: str,
    captured_at: str,
    temp_c: int | None,
    temp_source: str | None,
    io: DriveIOActivity,
) -> None:
    """Record a vitals reading — cheap temp + IO activity at this point in time."""
    with _connection() as conn:
        conn.execute(
            """
            INSERT INTO drive_vitals (
                drive_guid, captured_at, temp_c, temp_source,
                read_iops, write_iops, read_bytes_per_sec, write_bytes_per_sec, busy_pct
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                guid, captured_at, temp_c, temp_source,
                io.read_iops, io.write_iops, io.read_bytes_per_sec, io.write_bytes_per_sec, io.busy_pct,
            ),
        )


def record_raw_snapshot(guid: str, captured_at: str, probe: str, raw_json: str) -> int:
    """Persist a raw probe snapshot and return its row id."""
    with _connection() as conn:
        cursor = conn.execute(
            "INSERT INTO drive_raw_snapshots (drive_guid, captured_at, probe, raw_json) VALUES (?, ?, ?, ?)",
            (guid, captured_at, probe, raw_json),
        )
        return cursor.lastrowid


def get_latest_raw_snapshot(guid: str) -> sqlite3.Row | None:
    """Return the most recent raw snapshot for a drive, or None if none recorded yet."""
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM drive_raw_snapshots WHERE drive_guid = ? ORDER BY captured_at DESC LIMIT 1",
            (guid,),
        ).fetchone()


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

_HISTORY_TABLES = ("drive_signals", "drive_heartbeats", "drive_vitals", "drive_raw_snapshots")


def prune_history(cutoff_iso: str) -> None:
    """Delete time-series rows captured before cutoff_iso (ISO 8601 string)."""
    with _connection() as conn:
        for table in _HISTORY_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE captured_at < ?", (cutoff_iso,))


def get_last_pruned_at() -> str | None:
    """Return the ISO timestamp of the last history prune, or None if never pruned."""
    with _connection() as conn:
        row = conn.execute("SELECT last_pruned_at FROM collector_state").fetchone()
        return row[0] if row else None


def set_last_pruned_at(captured_at_iso: str) -> None:
    """Persist the timestamp of the most recent history prune."""
    with _connection() as conn:
        conn.execute("DELETE FROM collector_state")
        conn.execute("INSERT INTO collector_state (last_pruned_at) VALUES (?)", (captured_at_iso,))


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def record_job(job: Job) -> None:
    """Persist a terminal job (completed/failed/cancelled) for future History tab use."""
    with _connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO jobs (
                id, drive_guid, operation, category, params_json, status,
                result_json, error, created_at, started_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job.id, job.drive_guid, job.operation, job.category,
                json.dumps(job.params), job.status.value,
                json.dumps(job.result) if job.result is not None else None,
                job.error,
                job.created_at.isoformat(),
                job.started_at.isoformat() if job.started_at else None,
                job.finished_at.isoformat() if job.finished_at else None,
            ),
        )


def get_job_history(guid: str, limit: int = 50) -> list[sqlite3.Row]:
    """Return a drive's terminal jobs, most recent first."""
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM jobs WHERE drive_guid = ? ORDER BY created_at DESC LIMIT ?",
            (guid, limit),
        ).fetchall()
