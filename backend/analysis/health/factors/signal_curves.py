"""
analysis.health.factors.signal_curves — Counts and readings judged by a curve:
media errors, age and wear, heat and the link. A cycle count the drive rates
itself (SAS) is judged against that rating instead, and NVMe's percentage of
rated endurance used likewise.
"""

from dataclasses import dataclass

from analysis.health.curves import Curve, linear_curve, log_curve
from analysis.health.model import ENVIRONMENT, MEDIA, WEAR, Factor, HealthFacts


@dataclass(frozen=True)
class SignalFactor:
    kind: str
    label: str
    weight: float
    curve: Curve
    unit: str = ""       # display suffix for its value


# Unreadable now (data at risk today) and already lost weigh most; replaced
# sectors less; wear and environment least. Any media error starts at 79 or
# below (Degraded).
SIGNAL_FACTORS: dict[str, SignalFactor] = {
    "pending": SignalFactor(MEDIA, "Pending sectors", 0.35,
                            log_curve([(1, 55), (10, 42), (100, 28), (1000, 15), (10_000, 8)])),
    "uncorrected": SignalFactor(MEDIA, "Uncorrected errors", 0.35,
                                log_curve([(1, 50), (10, 37), (100, 24), (1000, 12), (10_000, 6)])),
    "reallocated": SignalFactor(MEDIA, "Reallocated sectors", 0.3,
                                log_curve([(1, 79), (10, 69), (100, 56), (1000, 40), (10_000, 20)])),
    "power_on_hours": SignalFactor(WEAR, "Power-on hours", 0.2,
                                   linear_curve([(40_000, 100), (50_000, 96), (70_000, 89), (100_000, 82)]), " h"),
    "load_unload_cycles": SignalFactor(WEAR, "Load/unload cycles", 0.2,
                                       linear_curve([(400_000, 100), (600_000, 94), (1_000_000, 85)])),
    "crc_errors": SignalFactor(ENVIRONMENT, "Interface CRC errors", 0.1,
                               log_curve([(1, 99), (100, 95), (10_000, 90)])),
    "temp": SignalFactor(ENVIRONMENT, "Temperature", 0.1,
                         linear_curve([(45, 100), (50, 97), (55, 93), (60, 88)]), "°C"),
}

# A cycle count against the drive's own rated lifetime, in % of rating, and
# NVMe's percentage used of rated endurance.
RATED_LIFE_CURVE = linear_curve([(80, 100), (100, 93), (150, 85), (200, 82)])
RATED_LIFE_WEIGHT = 0.2
_RATED_LIFE_ROWS = {
    "load_unload_cycles": ("load_unload_cycles", "Load/unload cycles"),
    "start_stop_cycles":  ("start_stop_cycles",  "Start/stop cycles"),
}


class SignalCurves:
    name = "signal_curves"

    def evaluate(self, facts: HealthFacts) -> list[Factor]:
        rated = self._rated(facts.attributes)
        factors = []
        for key, f in SIGNAL_FACTORS.items():
            if key in rated:
                continue    # judged against its own rating instead
            value = getattr(facts.signals, key)
            if value is None:
                continue
            factors.append(Factor(key=key, kind=f.kind, label=f.label, signal=key,
                                  value=f"{value:,}{f.unit}", standalone=f.curve(value), weight=f.weight))
        return factors + list(rated.values())

    def signal_curves(self) -> dict[str, Curve]:
        return {key: f.curve for key, f in SIGNAL_FACTORS.items()}

    @staticmethod
    def _rated(attributes: list[dict]) -> dict[str, Factor]:
        """Cycle counts against the drive's rating and NVMe wear, keyed by the
        signal they stand in for (or their own key)."""
        out = {}
        for row in attributes:
            metric = row.get("metric") or {}
            measured, rating = metric.get("measured"), metric.get("drive_threshold")
            if measured is None:
                continue
            if metric.get("kind") == "rated_lifetime" and rating and row.get("key") in _RATED_LIFE_ROWS:
                key, label = _RATED_LIFE_ROWS[row["key"]]
                pct = measured / rating * 100
                out[key] = Factor(key=key, kind=WEAR, label=label, signal=row.get("signal"),
                                  value=f"{pct:.0f}% of rated", standalone=RATED_LIFE_CURVE(pct),
                                  weight=RATED_LIFE_WEIGHT)
            elif metric.get("kind") == "percentage_used":
                out["percentage_used"] = Factor(key="percentage_used", kind=WEAR, label="Rated endurance used",
                                                value=f"{measured:.0f}%", standalone=RATED_LIFE_CURVE(measured),
                                                weight=RATED_LIFE_WEIGHT)
        return out
