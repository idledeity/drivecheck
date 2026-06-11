"""
analysis.severity — Shared ok/warn/crit classification helper.

Used by analysis.health (DCSignals -> DriveHealth) and analysis.smart_attributes
(raw smartctl fields -> AttributeRow) so both modules apply the same threshold
shape consistently.
"""


def flag(
    value: float | None,
    warn_gte: float | None = None,
    crit_gte: float | None = None,
) -> str:
    """Classify a value into "ok" | "warn" | "crit"."""
    if value is None:
        return "ok"
    if crit_gte is not None and value >= crit_gte:
        return "crit"
    if warn_gte is not None and value >= warn_gte:
        return "warn"
    return "ok"
