"""
analysis.health.factors.drive_verdict — What the drive says about itself: its
overall SMART verdict, an attribute at the drive's own threshold, an NVMe
critical warning or spare below threshold. "If it says it's failing, it's
failing": failing now starts in Critical, failed in the past in Degraded.
"""

from analysis.health.model import DRIVE, Factor, HealthFacts

FAILING_NOW = 10
FAILED_PAST = 75
WEIGHT = 0.35

_VERDICT_ROWS = ("smart_status", "critical_warning")


class DriveVerdict:
    name = "drive_verdict"

    def evaluate(self, facts: HealthFacts) -> list[Factor]:
        """One factor for all of it: one statement often shows in several
        places (an NVMe critical warning also fails the overall verdict), so
        they count once, listing what said it."""
        now, past = [], []
        for row in facts.attributes:
            metric = row.get("metric") or {}
            report = row.get("drive_report")
            label = row.get("label", row.get("key", "?"))
            if row.get("key") in _VERDICT_ROWS and report == "failed":
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
                # A temperature attribute that once went past its limit is
                # heat history, already judged as temperature.
                past.append(f"{label} failed in the past")
        failed = facts.signals.smart_passed is False
        if failed and not any(r.get("key") in _VERDICT_ROWS and r.get("drive_report") == "failed"
                              for r in facts.attributes):
            now.insert(0, "SMART overall verdict: FAILED")
        if not now and not past:
            return []
        return [Factor(
            key="drive_verdict", kind=DRIVE,
            label="Drive reports failure" if now else "Drive reported a failure",
            signal="smart_passed" if failed else None,
            value="; ".join(now or past), standalone=FAILING_NOW if now else FAILED_PAST, weight=WEIGHT,
        )]

    def signal_curves(self) -> dict:
        return {}
