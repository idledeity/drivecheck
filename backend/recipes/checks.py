"""
recipes.checks — Checks recipes can attach to their steps.

Imported by recipes.recipe_registry.discover(), so every kind here is
registered before a stored check is rebuilt.
"""

from operations.operation import ParamSpec
from recipes.recipe import Check

# Signals that rising during a step means the drive remapped sectors, or has
# sectors waiting to be remapped.
REMAP_SIGNALS = ["reallocated", "pending"]

# A recipe param for opting in to NoIncrease(REMAP_SIGNALS) on every step.
# Off by default: a batch normally runs to the end even if sectors remap.
FAIL_ON_NEW_REMAPS = ParamSpec(
    name="fail_on_new_remaps", label="Fail a step on new remapped sectors", type="boolean", default=False,
    tooltip="Mark a step failed if the drive's reallocated or pending sector counts went up while it ran. "
            "Off by default: the change is still shown in the batch's results.",
)


class NoIncrease(Check):
    """Fails the step if any of the named SMART signals rose between its
    before and after snapshots, e.g. new reallocated or pending sectors.

    Passes when it can't tell (a snapshot missing or failed, a signal the drive
    doesn't report): it only fails on an increase it actually saw.
    """

    kind = "no_increase"

    def __init__(self, signals: list[str]):
        self.signals = list(signals)

    def args(self) -> dict:
        return {"signals": self.signals}

    def evaluate(self, job) -> str | None:
        before = _signals(job.smart_before)
        after = _signals(job.smart_after)
        if before is None or after is None:
            return None
        rises = []
        for name in self.signals:
            old, new = before.get(name), after.get(name)
            if isinstance(old, int) and isinstance(new, int) and new > old:
                rises.append(f"{name.replace('_', ' ')} {old} → {new}")
        if not rises:
            return None
        return "SMART counts rose during this step: " + ", ".join(rises)


def _signals(snapshot: dict | None) -> dict | None:
    if not snapshot or "error" in snapshot:
        return None
    return snapshot.get("signals")
