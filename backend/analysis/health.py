"""
analysis.health — Classify DCSignals into per-signal flags and overall health.

Severity classification belongs here, not in the frontend: the telemetry probe
resolves protocol differences into DCSignals, and this module resolves DCSignals
into ok/warn/crit flags and an overall DriveHealth. The frontend only renders
those statuses.
"""

import logging
from dataclasses import fields

from analysis.severity import flag
from drives.drive_models import DCSignals, DriveHealth

logger = logging.getLogger(__name__)

# Points deducted from 100 per signal severity.
SIGNAL_WEIGHTS: dict[str, dict[str, int]] = {
    "reallocated":        {"warn": 15, "crit": 35},
    "pending":            {"warn": 10, "crit": 25},
    "uncorrected":        {"warn": 10, "crit": 25},
    "crc_errors":         {"warn":  5, "crit": 15},
    "power_on_hours":     {"warn":  5, "crit": 15},
    "load_unload_cycles": {"warn":  5, "crit": 10},
    "temp":               {"warn":  5, "crit": 15},
}

# When SMART itself reports failure the score is capped here regardless of
# individual signal deductions — the drive firmware is already telling us it's done.
SMART_FAIL_CAP = 40

# Score → status boundaries.
_HEALTHY_GTE  = 90
_DEGRADED_GTE = 60


def score_health(signals: DCSignals) -> DriveHealth:
    """Classify signals into per-field flags, a 0–100 health score, and overall status."""
    flags = {
        "reallocated":        flag(signals.reallocated,        warn_gte=1),
        "pending":            flag(signals.pending,            warn_gte=1),
        "uncorrected":        flag(signals.uncorrected,        crit_gte=1),
        "crc_errors":         flag(signals.crc_errors,         warn_gte=1),
        "power_on_hours":     flag(signals.power_on_hours,     warn_gte=40_000, crit_gte=60_000),
        "load_unload_cycles": flag(signals.load_unload_cycles, warn_gte=500_000, crit_gte=700_000),
        "temp":               flag(signals.temp,               warn_gte=45),
        # Not weighted below: a failed verdict caps the score instead (SMART_FAIL_CAP).
        "smart_passed":       "crit" if signals.smart_passed is False else "ok",
    }

    if signals.smart_passed is None:
        health_pct = None
        status = None
    else:
        score = 100
        for key, weights in SIGNAL_WEIGHTS.items():
            severity = flags.get(key, "ok")
            if severity == "crit":
                score -= weights["crit"]
            elif severity == "warn":
                score -= weights["warn"]
        if signals.smart_passed is False:
            score = min(score, SMART_FAIL_CAP)
        health_pct = max(0, score)

        if health_pct >= _HEALTHY_GTE:
            status = "Healthy"
        elif health_pct >= _DEGRADED_GTE:
            status = "Degraded"
        else:
            status = "Failing"

    logger.debug("scored health: status=%s pct=%s flags=%s", status, health_pct, flags)
    return DriveHealth(health_pct=health_pct, health_status=status, signal_flags=flags)


_DC_SIGNAL_FIELDS = {f.name for f in fields(DCSignals)}


def score_signals(signals: dict | None) -> DriveHealth:
    """score_health for a stored DCSignals dict, such as a job's SMART snapshot,
    so stored facts are judged by the same, current thresholds as the live
    drive. Keys a stored dict has but DCSignals no longer does are ignored."""
    known = {k: v for k, v in (signals or {}).items() if k in _DC_SIGNAL_FIELDS}
    return score_health(DCSignals(**known))
