"""
analysis.health.factors.self_test — The drive's latest self-test, if it
failed: the drive found sectors it can't read. An older failure followed by a
pass is left to the sector counts.
"""

from analysis.health.model import DRIVE, Factor, HealthFacts

FAILED = 30
WEIGHT = 0.35


class SelfTest:
    name = "self_test"

    def evaluate(self, facts: HealthFacts) -> list[Factor]:
        if not facts.self_test_log or facts.self_test_log[0].get("drive_report") != "failed":
            return []
        latest = facts.self_test_log[0]
        return [Factor(
            key="self_test", kind=DRIVE, label="Latest self-test failed",
            value=f"{latest.get('label', 'Self-test')}: {latest.get('value', 'failed')}",
            standalone=FAILED, weight=WEIGHT,
        )]

    def signal_curves(self) -> dict:
        return {}
