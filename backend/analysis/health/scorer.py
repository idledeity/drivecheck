"""
analysis.health.scorer — A scorer: factor tests plus a combiner, and the rules
every scorer shares (Unrated without a SMART verdict, per-signal flags from
the factor that judged the signal).
"""

import logging
from dataclasses import dataclass
from functools import cached_property

from analysis.health.curves import first_where
from analysis.health.model import Combiner, FactorTest, HealthFacts
from drives.drive_models import DriveHealth

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Scorer:
    name: str
    tests: tuple[FactorTest, ...]
    combiner: Combiner

    def score(self, facts: HealthFacts) -> DriveHealth:
        factors = [f for test in self.tests for f in test.evaluate(facts)]

        flags = {key: "ok" for key in self.signal_thresholds}
        for f in factors:
            if f.signal in flags:
                flags[f.signal] = self.combiner.flag(f.standalone)
        flags["smart_passed"] = "crit" if facts.signals.smart_passed is False else "ok"

        if facts.signals.smart_passed is None:
            logger.debug("not scored: no SMART verdict; flags=%s", flags)
            return DriveHealth(signal_flags=flags)

        combined = self.combiner.combine(factors)
        status = self.combiner.status_for(combined.score)
        logger.debug("scored health (%s): %s %s factors=%s", self.name, combined.score, status, combined.factors)
        return DriveHealth(health_pct=combined.score, health_status=status, signal_flags=flags,
                           factors=combined.factors, floor=combined.floor)

    @cached_property
    def signal_thresholds(self) -> dict[str, dict[str, int | None]]:
        """Value at or above which each curve-judged signal is flagged warn /
        crit, for charts and the SMART page to draw the same lines."""
        flag = self.combiner.flag
        return {
            key: {"warn_gte": first_where(curve, lambda s: flag(s) != "ok"),
                  "crit_gte": first_where(curve, lambda s: flag(s) == "crit")}
            for test in self.tests for key, curve in test.signal_curves().items()
        }
