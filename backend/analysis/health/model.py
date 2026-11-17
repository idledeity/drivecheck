"""
analysis.health.model — What a health scorer is made of: the facts it's
handed, the factors its tests find, and the two interfaces a scorer is built
from (FactorTest, Combiner). See analysis.health for how they fit together.
"""

from dataclasses import dataclass, field
from typing import Protocol

from drives.drive_models import DCSignals

# Kinds, from what a factor says about the drive. A combiner may treat them
# differently (the built-in one never lets wear or environment alone take a
# drive below Aging):
#   drive        — the drive's own statement (SMART verdict, its own threshold,
#                  a failed self-test)
#   media        — sectors it couldn't read or had to replace
#   wear         — age and use: a raised baseline, never a fault on its own
#   environment  — conditions around it (heat, the link), not the drive itself
DRIVE, MEDIA, WEAR, ENVIRONMENT = "drive", "media", "wear", "environment"

# The statuses every scorer maps its score onto (the UI knows exactly these),
# best first. "Unrated" (no score) is a scorer's None, not one of these.
STATUSES = ("Healthy", "Aging", "Degraded", "Failing", "Critical")


@dataclass(frozen=True)
class HealthFacts:
    """Everything a scorer may judge, all of it stored facts so any read, live
    or past, can be scored again by the current rules.

    signals         — the drive's DCSignals at the time
    attributes      — the latest read's AttributeFact rows (smart_attributes)
    self_test_log   — the drive's self-test log rows, newest first

    Planned (add when a test needs them): the drive's traits (model, for a
    per-model failure-rate baseline) and a lookup of earlier signals up to
    this read (for "reallocations growing")."""
    signals: DCSignals
    attributes: list[dict] = field(default_factory=list)
    self_test_log: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class Factor:
    """One thing that lowers a drive's health, as a test found it.

    standalone — the drive's health (0–100) if this were its only problem
    weight     — how much it counts beside a worse problem (combiner-defined;
                 the built-in combiner takes this share of its lost health)
    signal     — the DCSignals field it judges, if any, so that signal gets
                 its flag from this factor
    value      — what was found, display-ready"""
    key: str
    kind: str
    label: str
    value: str
    standalone: float
    weight: float
    signal: str | None = None


class FactorTest(Protocol):
    """Turns facts into factors. Pure and fast: it's run on every live read
    and again on every stored read a chart shows. A test that judges a signal
    by a curve publishes it (signal_curves), so the scorer can publish where
    that signal starts to warn and crit."""
    name: str

    def evaluate(self, facts: HealthFacts) -> list[Factor]: ...

    def signal_curves(self) -> dict: ...


@dataclass(frozen=True)
class Combined:
    score: int                  # 1–100
    factors: list[dict]         # each factor plus what it did (role, points)
    floor: int | None = None    # the floor that held the score up, if one did


class Combiner(Protocol):
    """Turns factors into a score and maps the score to a status. It also
    decides how a single factor is flagged, so flags and score agree."""
    name: str
    bands: dict                 # published for charts: {"healthy_gte": …, …}

    def combine(self, factors: list[Factor]) -> Combined: ...

    def status_for(self, score: int) -> str: ...

    def flag(self, standalone: float) -> str: ...
