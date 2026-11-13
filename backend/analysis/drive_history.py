"""
analysis.drive_history — Drive history for charts: bucketed vitals, signal
values where they change, the health score over time, and the jobs that ran.

Everything comes from stored facts (drive_vitals_rollup, drive_signals, jobs);
the health series is scored here, when served, by the current thresholds — the
same ones published alongside it, so a chart's threshold lines and status bands
match the score.
"""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from dataclasses import fields

from analysis.health import HEALTH_BANDS, SIGNAL_THRESHOLDS, score_signals
from database import db
from drives.drive_models import DCSignals

logger = logging.getLogger(__name__)

# Range key -> (span, bucket width), both seconds. Roughly 300 buckets each,
# except 1h, which is limited by the rollup's one-minute resolution.
RANGES: dict[str, tuple[int, int]] = {
    "1h":  (3600,       60),
    "24h": (86400,      300),
    "7d":  (7 * 86400,  1800),
    "30d": (30 * 86400, 7200),
    "90d": (90 * 86400, 21600),
}

# Signals scored for health from their highest value per bucket, and not sent
# as change series: temperature changes often and is charted from vitals, and
# power-on hours change every hour — reading every change of either costs
# far more than a bucket-accurate health line is worth.
_BUCKETED_SIGNALS = ["temp", "power_on_hours"]

# Every other signal: each change is read, scored and sent.
_EXACT_SIGNALS = [f.name for f in fields(DCSignals) if f.name not in _BUCKETED_SIGNALS]

# drive_signals stores every value as REAL; these are booleans in DCSignals.
_BOOL_SIGNALS = {"smart_passed"}


def build_history(
    guids: list[str],
    range_key: str,
    now: datetime | None = None,
    describe_job: Callable[[object], dict] | None = None,
) -> dict:
    """The history of each drive in guids over range_key (a RANGES key), ending
    now. Buckets are aligned to whole multiples of the bucket width, so the same
    range fetched again a little later lines up with the first fetch.

    Times are ISO strings in the same naive local time the database stores.
    describe_job(row) can add fields to each job (e.g. its name and outcome,
    which need the operation registry)."""
    span, bucket = RANGES[range_key]
    now = now or datetime.now()
    start = _floor(now - timedelta(seconds=span), bucket)
    start_iso, end_iso = start.isoformat(), now.isoformat()
    logger.debug("building %s history for %d drive(s) from %s", range_key, len(guids), start_iso)

    drives: dict[str, dict] = {g: {"vitals": _empty_vitals(), "signals": {}, "health": []} for g in guids}

    # Columnar: one list per field, index-aligned with "t" (the bucket start).
    # Buckets with no rollup rows — the drive wasn't seen, or the collector
    # wasn't running — are left out rather than sent as nulls.
    for row in db.get_vitals_buckets(guids, start_iso, end_iso, bucket):
        v = drives[row["drive_guid"]]["vitals"]
        v["t"].append((start + timedelta(seconds=row["bucket"] * bucket)).isoformat())
        v["temp_avg"].append(_round(row["temp_avg"], 2))
        v["temp_min"].append(row["temp_min"])
        v["temp_max"].append(row["temp_max"])
        v["read_bps"].append(_round(row["read_bps"]))
        v["write_bps"].append(_round(row["write_bps"]))
        v["busy_pct"].append(_round(row["busy_pct"], 1))

    changes: dict[str, list] = {g: [] for g in guids}
    for row in db.get_signal_changes(guids, _EXACT_SIGNALS, start_iso, end_iso):
        changes[row["drive_guid"]].append(row)
    for guid, bucket_rows in _by_drive_and_signal(
            db.get_signal_buckets(guids, _BUCKETED_SIGNALS, start_iso, end_iso, bucket)):
        changes[guid].extend(_bucket_events(bucket_rows, start, bucket, now))
    for guid, rows in changes.items():
        rows.sort(key=lambda r: r["captured_at"])    # stable, so same-time rows keep their order
        drives[guid]["signals"], drives[guid]["health"] = _signal_series(rows, start_iso)

    jobs = [
        {**_job(row), **(describe_job(row) if describe_job else {})}
        for row in db.get_jobs_between(guids, start_iso, end_iso)
    ]

    return {
        "range": range_key,
        "start": start_iso,
        "end": end_iso,
        "bucket_seconds": bucket,
        "thresholds": {"signals": SIGNAL_THRESHOLDS, "health": HEALTH_BANDS},
        "drives": drives,
        "jobs": jobs,
    }


def _signal_series(rows: list, start_iso: str) -> tuple[dict[str, list], list]:
    """One drive's change rows (time-ordered; bucketed signals at their bucket
    starts) as per-signal step series and a health step series. A value carried in from before the range is placed at
    the range start. Rows sharing a captured_at come from the same poll, so the
    score is taken once all of them are applied."""
    signals: dict[str, list] = {}
    health: list[dict] = []
    current: dict = {}
    i = 0
    while i < len(rows):
        at = rows[i]["captured_at"]
        t = max(at, start_iso)
        while i < len(rows) and rows[i]["captured_at"] == at:
            name, value = rows[i]["signal"], rows[i]["value"]
            if name in _BOOL_SIGNALS and value is not None:
                value = bool(value)
            current[name] = value
            if name not in _BUCKETED_SIGNALS:
                series = signals.setdefault(name, [])
                if series and series[-1]["t"] == t:
                    series[-1]["value"] = value    # two carried-in values both land on start
                else:
                    series.append({"t": t, "value": value})
            i += 1
        scored = score_signals(current)
        point = {"t": t, "health_pct": scored.health_pct, "health_status": scored.health_status}
        if health and health[-1]["t"] == t:
            health[-1] = point
        elif not health or (health[-1]["health_pct"], health[-1]["health_status"]) != (point["health_pct"], point["health_status"]):
            health.append(point)
    return signals, health


_VITALS_FIELDS = ("t", "temp_avg", "temp_min", "temp_max", "read_bps", "write_bps", "busy_pct")


def _empty_vitals() -> dict[str, list]:
    return {field: [] for field in _VITALS_FIELDS}


def _by_drive_and_signal(rows):
    """Group rows ordered by drive and signal into (drive_guid, rows) runs."""
    run: list = []
    for row in rows:
        if run and (run[-1]["drive_guid"], run[-1]["signal"]) != (row["drive_guid"], row["signal"]):
            yield run[0]["drive_guid"], run
            run = []
        run.append(row)
    if run:
        yield run[0]["drive_guid"], run


def _bucket_events(rows: list, start: datetime, width: int, end: datetime) -> list[dict]:
    """One drive's per-bucket rows of one signal (see db.get_signal_buckets) as
    change events for _signal_series: at each bucket's start, its worst value —
    the higher of the bucket's own maximum and the value carried into it — and,
    when the next bucket has no change, the bucket's last value at the next
    bucket's start, since that is what holds from then on."""
    events: list[dict] = []
    carried = None
    for i, row in enumerate(rows):
        if row["bucket"] is None:                    # carried in from before the range
            carried = row["last_value"]
            events.append({"captured_at": start.isoformat(), "signal": row["signal"], "value": carried})
            continue
        at = start + timedelta(seconds=row["bucket"] * width)
        worst = row["max_value"] if carried is None else max(row["max_value"], carried)
        events.append({"captured_at": at.isoformat(), "signal": row["signal"], "value": worst})
        carried = row["last_value"]
        after = at + timedelta(seconds=width)
        next_bucket = rows[i + 1]["bucket"] if i + 1 < len(rows) else None
        if after < end and next_bucket != row["bucket"] + 1 and carried != worst:
            events.append({"captured_at": after.isoformat(), "signal": row["signal"], "value": carried})
    return events


def _job(row) -> dict:
    return {
        "id": row["id"],
        "drive_guid": row["drive_guid"],
        "operation": row["operation"],
        "category": row["category"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def _floor(dt: datetime, seconds: int) -> datetime:
    """dt rounded down to a whole multiple of `seconds` since the epoch, with
    the naive time read as UTC — the same arithmetic as SQLite's strftime('%s')
    in db.get_vitals_buckets, so bucket indexes line up."""
    epoch = int((dt - datetime(1970, 1, 1)).total_seconds())
    return datetime(1970, 1, 1) + timedelta(seconds=epoch - epoch % seconds)


def _round(value: float | None, digits: int = 0) -> float | None:
    return None if value is None else round(value, digits)
