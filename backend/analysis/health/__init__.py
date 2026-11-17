"""
analysis.health — Judge a drive's SMART facts: per-signal flags, a 0–100
health score, its status, and the factors behind the score.

The score answers "how likely is this drive to fail, with data loss, soon".

A scorer is built from two kinds of parts (analysis.health.model):

  - factor tests (factors/): each takes the drive's facts (HealthFacts:
    signals, attribute rows, self-test log) and returns the factors it finds,
    each with a standalone score — the drive's health if that were its only
    problem — and a weight.
  - a combiner (combiners/): turns the factors into one score, maps it to a
    status, and decides how one factor is flagged. The built-in WorstFirst
    starts from the worst factor and lowers it for the rest.

There is one scorer today (DEFAULT_SCORER). The split is so another can be
swapped in later — a different combiner, extra tests (per-model failure rates,
reallocations growing), user-written ones discovered like custom probes —
picked in settings. Until then active_scorer() is the default.

Severity belongs here, not in the frontend or the probes: probes report facts,
this module judges them when they're served, so stored facts are always
judged by the current rules (nothing here is stored).
"""

from dataclasses import fields

from analysis.health.combiners.worst_first import WorstFirst
from analysis.health.factors.drive_verdict import DriveVerdict
from analysis.health.factors.self_test import SelfTest
from analysis.health.factors.signal_curves import SignalCurves
from analysis.health.model import HealthFacts
from analysis.health.scorer import Scorer
from drives.drive_models import DCSignals, DriveHealth

DEFAULT_SCORER = Scorer(
    name="default",
    tests=(SignalCurves(), DriveVerdict(), SelfTest()),
    combiner=WorstFirst(),
)


def active_scorer() -> Scorer:
    return DEFAULT_SCORER


def health_thresholds() -> dict:
    """What charts draw: each signal's warn/crit crossing points and the
    status bands, from the active scorer."""
    scorer = active_scorer()
    return {"signals": scorer.signal_thresholds, "health": scorer.combiner.bands}


def facts_from(signals: DCSignals, extras: dict | None = None) -> HealthFacts:
    """HealthFacts from signals plus a read's extras (smart_attributes,
    self_test_log, as the telemetry probe stores them, live or in a raw
    snapshot)."""
    extras = extras or {}
    return HealthFacts(signals=signals, attributes=extras.get("smart_attributes") or [],
                       self_test_log=extras.get("self_test_log") or [])


def score_health(signals: DCSignals, extras: dict | None = None) -> DriveHealth:
    return active_scorer().score(facts_from(signals, extras))


_DC_SIGNAL_FIELDS = {f.name for f in fields(DCSignals)}


def score_signals(signals: dict | None, extras: dict | None = None) -> DriveHealth:
    """score_health for a stored DCSignals dict (and, where kept, the read's
    attribute facts), such as a job's SMART snapshot or a history point.
    Keys a stored dict has but DCSignals no longer does are ignored."""
    known = {k: v for k, v in (signals or {}).items() if k in _DC_SIGNAL_FIELDS}
    return score_health(DCSignals(**known), extras)
