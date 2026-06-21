"""
analysis.health — Classify DCSignals into per-signal flags and overall health.

Severity classification belongs here, not in the frontend: the telemetry probe
resolves protocol differences into DCSignals, and this module resolves DCSignals
into ok/warn/crit flags and an overall DriveHealth. The frontend only renders
those statuses.
"""

import logging

from analysis.severity import flag
from drives.drive_models import DCSignals, DriveHealth

logger = logging.getLogger(__name__)


def score_health(signals: DCSignals) -> DriveHealth:
    """Classify signals into per-field flags and an overall health status."""
    flags = {
        "reallocated": flag(signals.reallocated, warn_gte=1),
        "pending":     flag(signals.pending,     warn_gte=1),
        "uncorrected": flag(signals.uncorrected, crit_gte=1),
        "temp":        flag(signals.temp,        warn_gte=45),
    }

    if signals.smart_passed is False:
        status = "Failing"
    elif (signals.reallocated or 0) > 0 or (signals.uncorrected or 0) > 0:
        status = "Degraded"
    elif signals.smart_passed is True:
        status = "Healthy"
    else:
        status = None  # Unrated

    logger.debug("scored health: status=%s flags=%s", status, flags)
    return DriveHealth(health_status=status, signal_flags=flags)
