"""
db.py — SQLite persistence layer for drivecheck.

Raw sqlite3, no ORM. WAL mode is enabled once at init so the collector's
writes don't block API request reads. Every call opens its own short-lived
connection — sqlite3 connections aren't safe to share across threads, and
the access patterns here are infrequent enough that connection overhead
doesn't matter.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from config import CONFIG

_DB_PATH = (Path(__file__).parent.parent / CONFIG["data"]["dir"] / "drivecheck.db").resolve()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS drive_records (
    guid           TEXT PRIMARY KEY,
    serial         TEXT,
    model          TEXT,
    capacity_bytes INTEGER,
    drive_type     TEXT,
    first_seen     TEXT NOT NULL,
    conflict_flag  INTEGER NOT NULL DEFAULT 0
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
