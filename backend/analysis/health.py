"""
analysis.health — Classify DCSignals into per-signal flags and overall health.

Severity classification belongs here, not in the frontend: the telemetry probe
resolves protocol differences into DCSignals, and this module resolves DCSignals
into ok/warn/crit flags and an overall DriveHealth. The frontend only renders
those statuses.
"""

from models import DCSignals, DriveHealth


def score_health(signals: DCSignals) -> DriveHealth:
    """Classify signals into per-field flags and an overall health status."""
    flags = {
        "reallocated": _flag(signals.reallocated, warn_gt=0),
        "pending":     _flag(signals.pending,     warn_gt=0),
        "uncorrected": _flag(signals.uncorrected, crit_gt=0),
        "temp":        _flag(signals.temp,        warn_gte=45),
    }

    if signals.smart_passed is False:
        status = "Failing"
    elif (signals.reallocated or 0) > 0 or (signals.uncorrected or 0) > 0:
        status = "Degraded"
    elif signals.smart_passed is True:
        status = "Healthy"
    else:
        status = None  # Unrated

    return DriveHealth(health_status=status, signal_flags=flags)


def _flag(
    value: int | None,
    warn_gt: int | None = None,
    warn_gte: int | None = None,
    crit_gt: int | None = None,
) -> str:
    """Classify a single signal value into "ok" | "warn" | "crit"."""
    if value is None:
        return "ok"
    if crit_gt is not None and value > crit_gt:
        return "crit"
    if warn_gt is not None and value > warn_gt:
        return "warn"
    if warn_gte is not None and value >= warn_gte:
        return "warn"
    return "ok"
