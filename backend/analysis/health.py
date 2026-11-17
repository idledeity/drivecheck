"""
analysis.health — Judge a drive's SMART facts: per-signal flags, a 0–100
health score, its status, and the factors behind the score.

The score answers "how likely is this drive to fail, with data loss, soon".
It is not a sum of penalties:

  1. Every problem is a *factor* with a standalone score: the drive's health
     if that were its only problem (FACTOR curves below, or a fixed score for
     what the drive says about itself).
  2. The worst factor is the starting point.
  3. Every other factor takes its weight's share of its own lost health off
     what's left: score × (1 − weight × (100 − standalone) / 100). So a second
     problem always lowers the score, but never to 0, and moves an already
     failing drive less in points.
  4. Age, wear and environment alone are a raised baseline, not a sign of a
     problem: they never take a drive below Aging (80), and heat or link
     errors alone never below Healthy (95).
  5. 0 is for a dead drive; a drive that answers scores at least 1.

Bands: Healthy 95–100 · Aging 80–94 · Degraded 40–79 · Failing 15–39 ·
Critical 1–14. The curves keep them true to their cause: any media error or
drive-reported failure starts at 79 or below, a drive that says it's failing
starts in Critical.

Signal flags come from the same curves: warn once a signal costs anything,
crit once it alone would be Failing (standalone < 40). SIGNAL_THRESHOLDS
publishes those crossing points for charts and the SMART page.

Severity belongs here, not in the frontend or the probes: probes report facts,
this module judges them when they're served, so stored facts are always judged
by the current rules.
"""

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass, fields

from drives.drive_models import DCSignals, DriveHealth

logger = logging.getLogger(__name__)

# ── score → status ───────────────────────────────────────────────────────────

# Published as data (GET /api/drives/history) so charts draw the same bands.
HEALTH_BANDS = {"healthy_gte": 95, "aging_gte": 80, "degraded_gte": 40, "failing_gte": 15}

_STATUS_BANDS = (
    (HEALTH_BANDS["healthy_gte"],  "Healthy"),
    (HEALTH_BANDS["aging_gte"],    "Aging"),
    (HEALTH_BANDS["degraded_gte"], "Degraded"),
    (HEALTH_BANDS["failing_gte"],  "Failing"),
)


def status_for(score: int) -> str:
    for lowest, status in _STATUS_BANDS:
        if score >= lowest:
            return status
    return "Critical"


# ── curves: a value → its standalone score ──────────────────────────────────

Curve = Callable[[float], float]


def _log_curve(points: list[tuple[float, float]]) -> Curve:
    """A count's standalone score: 100 at 0, then linear in log10(count)
    between points, flat past the last. Counts where each tenfold matters
    about as much as the last (sectors, errors)."""
    def score(n: float) -> float:
        if n <= 0:
            return 100.0
        if n <= points[0][0]:
            return points[0][1]
        for (a, ha), (b, hb) in zip(points, points[1:]):
            if n <= b:
                return ha + (hb - ha) * (math.log10(n) - math.log10(a)) / (math.log10(b) - math.log10(a))
        return points[-1][1]
    return score


def _linear_curve(points: list[tuple[float, float]]) -> Curve:
    """A value's standalone score, linear between points, flat outside them
    (hours, cycles, degrees)."""
    def score(x: float) -> float:
        if x <= points[0][0]:
            return points[0][1]
        for (a, ha), (b, hb) in zip(points, points[1:]):
            if x <= b:
                return ha + (hb - ha) * (x - a) / (b - a)
        return points[-1][1]
    return score


# Kinds, from what they say about the drive:
#   drive        — the drive's own statement (SMART verdict, its own threshold,
#                  a failed self-test)
#   media        — sectors it couldn't read or had to replace
#   wear         — age and use: a raised baseline, never a fault on its own
#   environment  — conditions around it (heat, the link), not the drive itself
DRIVE, MEDIA, WEAR, ENVIRONMENT = "drive", "media", "wear", "environment"


@dataclass(frozen=True)
class SignalFactor:
    kind: str
    label: str
    weight: float        # share of its lost health it takes as a comorbidity
    curve: Curve
    unit: str = ""       # display suffix for its value


# Unreadable now (data at risk today) and already lost weigh most; replaced
# sectors less; wear and environment least.
SIGNAL_FACTORS: dict[str, SignalFactor] = {
    "pending": SignalFactor(MEDIA, "Pending sectors", 0.35,
                            _log_curve([(1, 55), (10, 42), (100, 28), (1000, 15), (10_000, 8)])),
    "uncorrected": SignalFactor(MEDIA, "Uncorrected errors", 0.35,
                                _log_curve([(1, 50), (10, 37), (100, 24), (1000, 12), (10_000, 6)])),
    "reallocated": SignalFactor(MEDIA, "Reallocated sectors", 0.3,
                                _log_curve([(1, 79), (10, 69), (100, 56), (1000, 40), (10_000, 20)])),
    "power_on_hours": SignalFactor(WEAR, "Power-on hours", 0.2,
                                   _linear_curve([(40_000, 100), (50_000, 96), (70_000, 89), (100_000, 82)]), " h"),
    "load_unload_cycles": SignalFactor(WEAR, "Load/unload cycles", 0.2,
                                       _linear_curve([(400_000, 100), (600_000, 94), (1_000_000, 85)])),
    "crc_errors": SignalFactor(ENVIRONMENT, "Interface CRC errors", 0.1,
                               _log_curve([(1, 99), (100, 95), (10_000, 90)])),
    "temp": SignalFactor(ENVIRONMENT, "Temperature", 0.1,
                         _linear_curve([(45, 100), (50, 97), (55, 93), (60, 88)]), "°C"),
}

# A cycle count against the drive's own rated lifetime, in % of rating (SAS
# reports one), and NVMe's percentage used of rated endurance.
_RATED_LIFE_CURVE = _linear_curve([(80, 100), (100, 93), (150, 85), (200, 82)])
_RATED_LIFE_ROWS = {
    "load_unload_cycles": ("load_unload_cycles", "Load/unload cycles"),
    "start_stop_cycles":  ("start_stop_cycles",  "Start/stop cycles"),
}

# What the drive says about itself. Failing now (its overall verdict, an
# attribute at its own threshold, an NVMe critical warning) is Critical;
# an attribute that failed in the past is Degraded.
DRIVE_FAILING_NOW = 10
DRIVE_FAILED_PAST = 75
DRIVE_VERDICT_WEIGHT = 0.35
# The latest self-test failed: the drive found sectors it can't read.
SELF_TEST_FAILED = 30
SELF_TEST_WEIGHT = 0.35

# Age and wear alone hold a drive in Aging at worst; heat and the link alone
# in Healthy.
_FLOORS = {frozenset({WEAR}): 80, frozenset({ENVIRONMENT}): 95, frozenset({WEAR, ENVIRONMENT}): 80}

_FLAG_CRIT_BELOW = 40


# ── thresholds published for charts / the SMART page ────────────────────────

def _first_below(curve: Curve, limit: float, hi: int = 10**9) -> int | None:
    """The smallest whole value whose standalone score is below limit (curves
    only fall), or None if none is."""
    if curve(hi) >= limit:
        return None
    lo = 0
    while lo < hi:
        mid = (lo + hi) // 2
        if curve(mid) < limit:
            hi = mid
        else:
            lo = mid + 1
    return lo


# Value at or above which a signal is flagged warn / crit — where its curve
# starts to cost, and where it alone would be Failing.
SIGNAL_THRESHOLDS: dict[str, dict[str, float | None]] = {
    key: {"warn_gte": _first_below(f.curve, 100), "crit_gte": _first_below(f.curve, _FLAG_CRIT_BELOW)}
    for key, f in SIGNAL_FACTORS.items()
}


def _flag(standalone: float) -> str:
    if standalone < _FLAG_CRIT_BELOW:
        return "crit"
    return "warn" if standalone < 100 else "ok"


# ── scoring ─────────────────────────────────────────────────────────────────

def _signal_factors(signals: DCSignals, rated: dict[str, dict]) -> list[dict]:
    factors = []
    for key, f in SIGNAL_FACTORS.items():
        if key in rated:
            continue    # judged against its own rating instead
        value = getattr(signals, key)
        if value is None:
            continue
        factors.append({
            "key": key, "kind": f.kind, "label": f.label, "signal": key,
            "value": f"{value:,}{f.unit}", "standalone": f.curve(value), "weight": f.weight,
        })
    return factors + list(rated.values())


def _rated_factors(attributes: list[dict]) -> dict[str, dict]:
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
            out[key] = {
                "key": key, "kind": WEAR, "label": label, "signal": row.get("signal"),
                "value": f"{pct:.0f}% of rated", "standalone": _RATED_LIFE_CURVE(pct), "weight": 0.2,
            }
        elif metric.get("kind") == "percentage_used":
            out["percentage_used"] = {
                "key": "percentage_used", "kind": WEAR, "label": "Rated endurance used", "signal": None,
                "value": f"{measured:.0f}%", "standalone": _RATED_LIFE_CURVE(measured), "weight": 0.2,
            }
    return out


def _drive_verdict(signals: DCSignals, attributes: list[dict]) -> dict | None:
    """One factor for everything the drive says about itself: failing now is
    Critical, failed in the past Degraded. One statement often shows in several
    places (an NVMe critical warning also fails the overall verdict), so they
    count once, listing what said it."""
    now, past = [], []
    for row in attributes:
        metric = row.get("metric") or {}
        report = row.get("drive_report")
        label = row.get("label", row.get("key", "?"))
        if row.get("key") in ("smart_status", "critical_warning") and report == "failed":
            # The overall verdict in the drive's own words where it gives
            # some (SAS: the informational exception string).
            now.append(row.get("detail") or f"{label}: {row.get('value')}")
        elif report == "failed" or (
                metric.get("kind") == "normalized_value" and metric.get("drive_threshold")
                and metric.get("measured") is not None and metric["measured"] <= metric["drive_threshold"]):
            now.append(f"{label} at the drive's own threshold")
        elif metric.get("kind") == "available_spare" and metric.get("drive_threshold") is not None \
                and metric.get("measured") is not None and metric["measured"] <= metric["drive_threshold"]:
            now.append(f"{label} at or below the drive's threshold")
        elif report == "past" and row.get("signal") != "temp":
            # A temperature attribute that once went past its limit is heat
            # history, already judged as temperature.
            past.append(f"{label} failed in the past")
    if signals.smart_passed is False and not any(
            r.get("key") in ("smart_status", "critical_warning") and r.get("drive_report") == "failed"
            for r in attributes):
        now.insert(0, "SMART overall verdict: FAILED")
    if not now and not past:
        return None
    return {
        "key": "drive_verdict", "kind": DRIVE, "label": "Drive reports failure" if now else "Drive reported a failure",
        "signal": "smart_passed" if signals.smart_passed is False else None,
        "value": "; ".join(now or past), "standalone": DRIVE_FAILING_NOW if now else DRIVE_FAILED_PAST,
        "weight": DRIVE_VERDICT_WEIGHT,
    }


def _self_test(self_test_log: list[dict]) -> dict | None:
    """The drive's latest self-test, if it failed. An older failure followed
    by a pass is left to the sector counts."""
    if not self_test_log or self_test_log[0].get("drive_report") != "failed":
        return None
    latest = self_test_log[0]
    return {
        "key": "self_test", "kind": DRIVE, "label": "Latest self-test failed", "signal": None,
        "value": f"{latest.get('label', 'Self-test')}: {latest.get('value', 'failed')}",
        "standalone": SELF_TEST_FAILED, "weight": SELF_TEST_WEIGHT,
    }


def score_health(signals: DCSignals, extras: dict | None = None) -> DriveHealth:
    """Flags, score, status and factors for a drive's signals, plus — where a
    read has them — its attribute facts and self-test log (extras:
    smart_attributes, self_test_log, as the telemetry probe stores them)."""
    attributes = (extras or {}).get("smart_attributes") or []
    self_test_log = (extras or {}).get("self_test_log") or []

    factors = _signal_factors(signals, _rated_factors(attributes))
    for extra in (_drive_verdict(signals, attributes), _self_test(self_test_log)):
        if extra:
            factors.append(extra)

    flags = {key: "ok" for key in SIGNAL_FACTORS}
    for f in factors:
        if f["signal"] in flags:
            flags[f["signal"]] = _flag(f["standalone"])
    flags["smart_passed"] = "crit" if signals.smart_passed is False else "ok"

    if signals.smart_passed is None:
        logger.debug("not scored: no SMART verdict; flags=%s", flags)
        return DriveHealth(signal_flags=flags)

    score, shown, floor = _combine([f for f in factors if f["standalone"] < 100])
    status = status_for(score)
    logger.debug("scored health: %s %s factors=%s", score, status, shown)
    return DriveHealth(health_pct=score, health_status=status, signal_flags=flags, factors=shown, floor=floor)


def _combine(factors: list[dict]) -> tuple[int, list[dict], int | None]:
    """The worst factor's standalone score, lowered by each other factor in
    turn (worst first). Returns the score, the factors with what each did,
    and the floor that held it, if one did."""
    if not factors:
        return 100, [], None
    ordered = sorted(factors, key=lambda f: (f["standalone"], -f["weight"]))
    score = ordered[0]["standalone"]
    shown = [{**ordered[0], "role": "start", "points": round(score, 1)}]
    for f in ordered[1:]:
        after = score * (1 - f["weight"] * (100 - f["standalone"]) / 100)
        shown.append({**f, "role": "adds", "points": round(after - score, 1)})
        score = after
    floor = _FLOORS.get(frozenset(f["kind"] for f in ordered))
    held = floor is not None and score < floor
    score = max(score, floor) if held else score
    for f in shown:
        f["standalone"] = round(f["standalone"])
    return max(1, round(score)), shown, floor if held else None


# ── stored facts ────────────────────────────────────────────────────────────

_DC_SIGNAL_FIELDS = {f.name for f in fields(DCSignals)}


def score_signals(signals: dict | None, extras: dict | None = None) -> DriveHealth:
    """score_health for a stored DCSignals dict (and, where kept, the report's
    attribute facts), such as a job's SMART snapshot or a saved raw report, so
    stored facts are judged by the same, current rules as the live drive.
    Keys a stored dict has but DCSignals no longer does are ignored."""
    known = {k: v for k, v in (signals or {}).items() if k in _DC_SIGNAL_FIELDS}
    return score_health(DCSignals(**known), extras)
