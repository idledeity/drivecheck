"""
analysis.health.combiners.worst_first — The worst factor sets the score;
every other factor lowers it as a comorbidity.

  1. The worst factor's standalone score is the starting point.
  2. Every other factor (worst first) takes its weight's share of its own lost
     health off what's left: score × (1 − weight × (100 − standalone) / 100).
     So a second problem always lowers the score, but never to 0, and moves
     an already failing drive less in points.
  3. Age, wear and environment alone are a raised baseline, not a sign of a
     problem: they never take a drive below Aging (80), and heat or link
     errors alone never below Healthy (95).
  4. 0 is for a dead drive; a drive that answers scores at least 1.

Bands: Healthy 95–100 · Aging 80–94 · Degraded 40–79 · Failing 15–39 ·
Critical 1–14. A factor is flagged warn once it costs anything, crit once it
alone would be Failing.
"""

from dataclasses import asdict

from analysis.health.model import ENVIRONMENT, WEAR, Combined, Factor

_FLOORS = {frozenset({WEAR}): 80, frozenset({ENVIRONMENT}): 95, frozenset({WEAR, ENVIRONMENT}): 80}


class WorstFirst:
    name = "worst_first"
    bands = {"healthy_gte": 95, "aging_gte": 80, "degraded_gte": 40, "failing_gte": 15}

    def combine(self, factors: list[Factor]) -> Combined:
        factors = [f for f in factors if f.standalone < 100]
        if not factors:
            return Combined(score=100, factors=[])
        ordered = sorted(factors, key=lambda f: (f.standalone, -f.weight))
        score = ordered[0].standalone
        shown = [{**asdict(ordered[0]), "role": "start", "points": round(score, 1)}]
        for f in ordered[1:]:
            after = score * (1 - f.weight * (100 - f.standalone) / 100)
            shown.append({**asdict(f), "role": "adds", "points": round(after - score, 1)})
            score = after
        floor = _FLOORS.get(frozenset(f.kind for f in ordered))
        held = floor is not None and score < floor
        score = max(score, floor) if held else score
        for f in shown:
            f["standalone"] = round(f["standalone"])
        return Combined(score=max(1, round(score)), factors=shown, floor=floor if held else None)

    def status_for(self, score: int) -> str:
        b = self.bands
        if score >= b["healthy_gte"]:
            return "Healthy"
        if score >= b["aging_gte"]:
            return "Aging"
        if score >= b["degraded_gte"]:
            return "Degraded"
        if score >= b["failing_gte"]:
            return "Failing"
        return "Critical"

    def flag(self, standalone: float) -> str:
        if standalone < self.bands["degraded_gte"]:
            return "crit"
        return "warn" if standalone < 100 else "ok"
