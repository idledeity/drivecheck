"""
analysis.smart_attributes — Judge SMART attribute and self-test facts.

Probes store AttributeFact rows (drives.drive_models) — facts, no ok/warn/crit.
This module derives each row's status when it is served, so stored rows are
always judged by the current rules:
  signal       — the row takes that DCSignals field's flag (analysis.health),
                 one threshold definition for the card and the SMART tab alike
  metric       — judged by the METRIC_RULES rule for its kind
  drive_report — the drive's own statement: failed → crit, marginal → warn
A row takes the worst status of the inputs it has; a row with none is ok.
"""

import logging
from collections.abc import Callable

from analysis.health import score_signals
from analysis.severity import flag

logger = logging.getLogger(__name__)

_RANK = {"ok": 0, "warn": 1, "crit": 2}

_DRIVE_REPORT_STATUS = {"failed": "crit", "marginal": "warn", "ok": "ok"}


def _normalized_value(measured: float, drive_threshold: float | None) -> str:
    # ATA: the drive's normalized value at or below its own threshold is a
    # failing attribute. A threshold of 0 means the drive sets none.
    return "crit" if drive_threshold and measured <= drive_threshold else "ok"


def _rated_lifetime(measured: float, drive_threshold: float | None) -> str:
    if not drive_threshold:
        return "ok"
    return flag(measured / drive_threshold, warn_gte=0.8, crit_gte=1.0)


def _available_spare(measured: float, drive_threshold: float | None) -> str:
    return "warn" if drive_threshold is not None and measured <= drive_threshold else "ok"


# Metric kind -> rule(measured, drive_threshold) -> "ok" | "warn" | "crit".
METRIC_RULES: dict[str, Callable[[float, float | None], str]] = {
    "normalized_value":  _normalized_value,
    "rated_lifetime":    _rated_lifetime,
    "available_spare":   _available_spare,
    "percentage_used":   lambda measured, _t: flag(measured, warn_gte=80, crit_gte=100),
    "error_log_entries": lambda measured, _t: flag(measured, warn_gte=1),
}


def judge_row(row: dict, signal_flags: dict[str, str]) -> dict:
    """An AttributeRow dict ({key, label, value, status, detail}) for a stored
    AttributeFact dict. A row stored by an older version already carries its
    status and none of the judging inputs, so it is returned as stored."""
    if "status" in row:
        return row
    statuses = ["ok"]
    if row.get("signal"):
        statuses.append(signal_flags.get(row["signal"], "ok"))
    metric = row.get("metric")
    if metric:
        # .get: one unreadable stored row mustn't fail the whole report.
        rule = METRIC_RULES.get(metric.get("kind"))
        if rule is None:
            logger.debug("no rule for metric %r on row %s; not judged", metric, row.get("key"))
        elif metric.get("measured") is not None:
            statuses.append(rule(metric["measured"], metric.get("drive_threshold")))
    if row.get("drive_report"):
        statuses.append(_DRIVE_REPORT_STATUS.get(row["drive_report"], "ok"))
    return {
        "key": row["key"],
        "label": row["label"],
        "value": row["value"],
        "status": max(statuses, key=_RANK.__getitem__),
        "detail": row.get("detail"),
    }


def judge_report(raw: dict, signals: dict | None = None) -> dict:
    """A stored raw snapshot (drive_raw_snapshots.raw_json) with its
    smart_attributes and self_test_log rows judged. Signal flags come from the
    snapshot's own stored signals, else `signals` (e.g. the job summary that
    points at an older snapshot stored without them)."""
    signal_flags = score_signals(raw.get("signals") or signals).signal_flags
    judged = dict(raw)
    for key in ("smart_attributes", "self_test_log"):
        if key in raw:
            judged[key] = [judge_row(row, signal_flags) for row in raw[key]]
    return judged
