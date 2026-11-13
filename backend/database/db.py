"""
db.py — SQLite persistence layer for drivecheck.

Raw sqlite3, no ORM. WAL mode is enabled once at init so the collector's
writes don't block API request reads. Every call opens its own short-lived
connection — sqlite3 connections aren't safe to share across threads, and
the access patterns here are infrequent enough that connection overhead
doesn't matter.
"""

import json
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from system_utils import paths
from drives.drive_models import DriveIOActivity
from jobs.job_models import Job

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS drive_records (
    guid           TEXT PRIMARY KEY,
    serial         TEXT,
    model          TEXT,
    capacity_bytes INTEGER,
    drive_type     TEXT,
    first_seen     TEXT NOT NULL,
    conflict_flag  INTEGER NOT NULL DEFAULT 0,
    label          TEXT,
    locked         INTEGER NOT NULL DEFAULT 0
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

-- Per-minute rollup of drive_vitals, the source for history charts. Rebuildable
-- from drive_vitals while the raw rows last (see rollup_vitals); kept for the
-- full history window, while raw rows have their own, shorter one.
-- captured_at is the minute's start. *_avg are means over the minute's
-- non-null samples; temp_n / io_n count them, so coarser buckets can be
-- weighted correctly.
CREATE TABLE IF NOT EXISTS drive_vitals_rollup (
    drive_guid          TEXT NOT NULL,
    captured_at         TEXT NOT NULL,
    temp_n              INTEGER NOT NULL,
    temp_min            INTEGER,
    temp_avg            REAL,
    temp_max            INTEGER,
    io_n                INTEGER NOT NULL,
    read_iops_avg       REAL,
    write_iops_avg      REAL,
    read_bps_avg        REAL,
    write_bps_avg       REAL,
    busy_pct_avg        REAL,
    PRIMARY KEY (drive_guid, captured_at)
) WITHOUT ROWID;

-- Single-row table of collector bookkeeping that must survive restarts.
CREATE TABLE IF NOT EXISTS collector_state (
    last_pruned_at TEXT
);

-- One row per job (queued/running/terminal). Active jobs are written on
-- creation and at RUNNING-transition so they survive a restart; terminal
-- jobs are updated in place when the operation finishes.
CREATE TABLE IF NOT EXISTS jobs (
    id             TEXT PRIMARY KEY,
    drive_guid     TEXT NOT NULL,
    operation      TEXT NOT NULL,
    category       TEXT NOT NULL,
    params_json    TEXT NOT NULL,
    status         TEXT NOT NULL,
    result_json    TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    reattach_json  TEXT,
    -- Condensed SMART summaries around the run (see Job.smart_before/smart_after);
    -- each one's snapshot_id references the full report in drive_raw_snapshots.
    smart_before_json TEXT,
    smart_after_json  TEXT,
    queue_position    INTEGER  -- Job.queue_position: run order while queued, else NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_drive_guid ON jobs (drive_guid, created_at);
"""


def _db_path() -> Path:
    return paths.data_dir() / "drivecheck.db"


@contextmanager
def _connection():
    conn = sqlite3.connect(_db_path())
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
    logger.info("initializing database: %s", _db_path())
    _db_path().parent.mkdir(parents=True, exist_ok=True)
    with _connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply schema changes that CREATE TABLE IF NOT EXISTS can't express on existing DBs."""
    drive_record_cols = {row[1] for row in conn.execute("PRAGMA table_info(drive_records)")}
    if "label" not in drive_record_cols:
        conn.execute("ALTER TABLE drive_records ADD COLUMN label TEXT")
    if "locked" not in drive_record_cols:
        conn.execute("ALTER TABLE drive_records ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")

    job_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "reattach_json" not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN reattach_json TEXT")
    for col in ("smart_before_json", "smart_after_json"):
        if col not in job_cols:
            conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} TEXT")
    if "queue_position" not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN queue_position INTEGER")


# ---------------------------------------------------------------------------
# Drive records
# ---------------------------------------------------------------------------

def get_drive_record(guid: str) -> sqlite3.Row | None:
    """Return the persisted drive record for a GUID, or None if not yet seen."""
    logger.debug("looking up drive record: %s", guid)
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
    logger.debug("upserting drive record: guid=%s serial=%s model=%s", guid, serial, model)
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
    logger.info("setting label for drive %s: %r", guid, label)
    with _connection() as conn:
        conn.execute("UPDATE drive_records SET label = ? WHERE guid = ?", (label, guid))


def set_drive_locked(guid: str, locked: bool) -> None:
    """Persist the locked state for a drive."""
    logger.info("setting locked for drive %s: %s", guid, locked)
    with _connection() as conn:
        conn.execute("UPDATE drive_records SET locked = ? WHERE guid = ?", (int(locked), guid))


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
        logger.debug("no non-null signals to record for drive %s", guid)
        return
    logger.debug("recording %d signal(s) for drive %s", len(rows), guid)
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
    logger.debug("recording heartbeat for drive %s: temp_c=%s", guid, temp_c)
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
    logger.debug("recording vitals for drive %s: temp_c=%s source=%s", guid, temp_c, temp_source)
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
    logger.debug("recording raw snapshot for drive %s (probe=%s, %d bytes)", guid, probe, len(raw_json))
    with _connection() as conn:
        cursor = conn.execute(
            "INSERT INTO drive_raw_snapshots (drive_guid, captured_at, probe, raw_json) VALUES (?, ?, ?, ?)",
            (guid, captured_at, probe, raw_json),
        )
        return cursor.lastrowid


def get_raw_snapshot(snapshot_id: int) -> sqlite3.Row | None:
    """Return one raw snapshot row by id, or None if it doesn't exist (e.g. pruned)."""
    logger.debug("looking up raw snapshot %s", snapshot_id)
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute("SELECT * FROM drive_raw_snapshots WHERE id = ?", (snapshot_id,)).fetchone()


def get_latest_raw_snapshot(guid: str) -> sqlite3.Row | None:
    """Return the most recent raw snapshot for a drive, or None if none recorded yet."""
    logger.debug("looking up latest raw snapshot for drive %s", guid)
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM drive_raw_snapshots WHERE drive_guid = ? ORDER BY captured_at DESC LIMIT 1",
            (guid,),
        ).fetchone()


# Minute bucket of an ISO captured_at ("2026-11-13T07:52:26.437121" -> "2026-11-13T07:52:00").
_MINUTE_OF = "substr(captured_at, 1, 16) || ':00'"


def rollup_vitals(end_iso: str, start_iso: str | None = None) -> int:
    """Roll raw drive_vitals rows up into drive_vitals_rollup, one row per drive
    per minute, for minutes starting at or after start_iso (None: from the
    oldest raw row) and before end_iso. Both bounds should be minute starts, so
    no minute is rolled from part of its samples. Re-rolling a minute replaces
    its row. Returns the number of rollup rows written."""
    logger.debug("rolling up vitals from %s to %s", start_iso or "the start", end_iso)
    with _connection() as conn:
        cursor = conn.execute(
            f"""
            INSERT OR REPLACE INTO drive_vitals_rollup (
                drive_guid, captured_at, temp_n, temp_min, temp_avg, temp_max,
                io_n, read_iops_avg, write_iops_avg, read_bps_avg, write_bps_avg, busy_pct_avg
            )
            SELECT drive_guid, {_MINUTE_OF},
                   count(temp_c), min(temp_c), avg(temp_c), max(temp_c),
                   count(read_bytes_per_sec), avg(read_iops), avg(write_iops),
                   avg(read_bytes_per_sec), avg(write_bytes_per_sec), avg(busy_pct)
              FROM drive_vitals
             WHERE captured_at >= ? AND captured_at < ?
             GROUP BY drive_guid, {_MINUTE_OF}
            """,
            (start_iso or "", end_iso),
        )
        return cursor.rowcount


def get_last_vitals_rollup_at() -> str | None:
    """The start of the newest rolled-up minute across all drives, or None if
    nothing has been rolled up yet."""
    with _connection() as conn:
        return conn.execute("SELECT max(captured_at) FROM drive_vitals_rollup").fetchone()[0]


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

_HISTORY_TABLES = ("drive_signals", "drive_heartbeats", "drive_vitals_rollup", "drive_raw_snapshots")


# Raw snapshots a job's SMART summary points at (see Job.smart_before/smart_after).
_JOB_SNAPSHOT_IDS = """
    SELECT json_extract(smart_before_json, '$.snapshot_id') FROM jobs
     WHERE json_extract(smart_before_json, '$.snapshot_id') IS NOT NULL
    UNION
    SELECT json_extract(smart_after_json, '$.snapshot_id') FROM jobs
     WHERE json_extract(smart_after_json, '$.snapshot_id') IS NOT NULL
"""


def prune_history(
    cutoff_iso: str,
    keep_job_snapshots: bool = True,
    raw_vitals_cutoff_iso: str | None = None,
) -> None:
    """Delete time-series rows captured before cutoff_iso (ISO 8601 string).

    Raw drive_vitals rows have their own cutoff, raw_vitals_cutoff_iso (the
    later of the two wins; None means cutoff_iso) — charts read the per-minute
    drive_vitals_rollup, which follows cutoff_iso.

    With keep_job_snapshots, raw snapshots referenced by a job are kept past
    the cutoff, so a job's full before/after SMART reports don't expire.
    """
    raw_cutoff = max(cutoff_iso, raw_vitals_cutoff_iso or cutoff_iso)
    logger.info(
        "pruning history older than %s from %s, and raw vitals older than %s%s",
        cutoff_iso, ", ".join(_HISTORY_TABLES), raw_cutoff,
        " (keeping snapshots referenced by jobs)" if keep_job_snapshots else "",
    )
    with _connection() as conn:
        for table, cutoff in [*((t, cutoff_iso) for t in _HISTORY_TABLES), ("drive_vitals", raw_cutoff)]:
            sql = f"DELETE FROM {table} WHERE captured_at < ?"
            if table == "drive_raw_snapshots" and keep_job_snapshots:
                sql += f" AND id NOT IN ({_JOB_SNAPSHOT_IDS})"
            deleted = conn.execute(sql, (cutoff,)).rowcount
            logger.debug("pruned %d row(s) from %s", deleted, table)


def get_last_pruned_at() -> str | None:
    """Return the ISO timestamp of the last history prune, or None if never pruned."""
    logger.debug("looking up last history prune timestamp")
    with _connection() as conn:
        row = conn.execute("SELECT last_pruned_at FROM collector_state").fetchone()
        return row[0] if row else None


def set_last_pruned_at(captured_at_iso: str) -> None:
    """Persist the timestamp of the most recent history prune."""
    logger.debug("setting last history prune timestamp: %s", captured_at_iso)
    with _connection() as conn:
        conn.execute("DELETE FROM collector_state")
        conn.execute("INSERT INTO collector_state (last_pruned_at) VALUES (?)", (captured_at_iso,))


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def record_job(job: Job, reattach_data: dict | None = None) -> None:
    """Persist a job row (any status) for History tab use and restart recovery.

    Called at creation (QUEUED), at RUNNING-transition, again once reattach data
    becomes available (after the external resource is acquired), and finally when
    the job reaches a terminal state.
    """
    logger.debug("recording job %s: %s (%s)", job.id[:8], job.operation, job.status.value)
    with _connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO jobs (
                id, drive_guid, operation, category, params_json, status,
                result_json, error, created_at, started_at, finished_at,
                reattach_json, smart_before_json, smart_after_json, queue_position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job.id, job.drive_guid, job.operation, job.category,
                json.dumps(job.params), job.status.value,
                json.dumps(job.result) if job.result is not None else None,
                job.error,
                job.created_at.isoformat(),
                job.started_at.isoformat() if job.started_at else None,
                job.finished_at.isoformat() if job.finished_at else None,
                json.dumps(reattach_data) if reattach_data is not None else None,
                json.dumps(job.smart_before) if job.smart_before is not None else None,
                json.dumps(job.smart_after) if job.smart_after is not None else None,
                job.queue_position,
            ),
        )


def set_queue_positions(positions: dict[str, int | None]) -> None:
    """Update queued jobs' run order without rewriting the rest of their rows."""
    if not positions:
        return
    with _connection() as conn:
        conn.executemany(
            "UPDATE jobs SET queue_position = ? WHERE id = ?",
            [(pos, job_id) for job_id, pos in positions.items()],
        )


def get_active_jobs() -> list[sqlite3.Row]:
    """Return all jobs with non-terminal status (queued or running) from the previous run,
    queued ones in their saved run order (rows from before queue_position existed
    fall back to creation order)."""
    from jobs.job_models import JobStatus  # local import to avoid circular dependency at module load
    logger.debug("loading active jobs for restart recovery")
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM jobs WHERE status IN (?, ?)"
            " ORDER BY queue_position IS NULL, queue_position, created_at",
            (JobStatus.QUEUED.value, JobStatus.RUNNING.value),
        ).fetchall()


def get_job_history(
    guids: str | list[str] | None = None,
    limit: int = 50,
    *,
    since: str | None = None,
    statuses: list[str] | None = None,
    operations: list[str] | None = None,
    exclude_categories: list[str] | None = None,
) -> list[sqlite3.Row]:
    """Return jobs, most recently finished (or, if unfinished, created) first.

    guids: one drive, several, or None for every drive. since: an ISO timestamp;
    only jobs that finished at or after it. The rest filter on the column they
    name; None means no filter.
    """
    if isinstance(guids, str):
        guids = [guids]
    where, args = [], []
    def any_of(column: str, values: list[str] | None) -> None:
        if values is not None:
            where.append(f"{column} IN ({','.join('?' * len(values))})" if values else "0")
            args.extend(values)
    any_of("drive_guid", guids)
    any_of("status", statuses)
    any_of("operation", operations)
    if exclude_categories:
        where.append(f"category NOT IN ({','.join('?' * len(exclude_categories))})")
        args.extend(exclude_categories)
    if since is not None:
        where.append("finished_at >= ?")
        args.append(since)
    sql = "SELECT * FROM jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?"
    logger.debug("looking up job history: %s %r (limit=%d)", sql, args, limit)
    with _connection() as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(sql, (*args, limit)).fetchall()


def get_job_smart(job_id: str) -> tuple[dict | None, dict | None] | None:
    """Return a job's (smart_before, smart_after) summaries, or None if no such job.
    Each summary's snapshot_id points at the full report in drive_raw_snapshots."""
    logger.debug("looking up SMART snapshots for job %s", job_id[:8])
    with _connection() as conn:
        row = conn.execute(
            "SELECT smart_before_json, smart_after_json FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
    if row is None:
        return None
    return tuple(json.loads(v) if v else None for v in row)
