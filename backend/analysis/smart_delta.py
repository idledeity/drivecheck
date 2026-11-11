"""
analysis.smart_delta — Compare the SMART snapshots taken before and after a job.

A burn-in test (badblocks, dd write, a long self-test) can pass while the drive
quietly remaps sectors, so its effect on the error counters matters as much as
its own verdict. This turns a job's smart_before/smart_after snapshots into a
per-signal comparison and a list of the counters that got worse.

Works on the `signals` dicts (asdict(DCSignals)) so it reads stored snapshots
and history rows alike, without importing the collector.
"""

# Error counters: any increase during a run is a warning sign.
WORSENING_COUNTERS = ("reallocated", "pending", "uncorrected", "crc_errors", "reallocated_events")


def compare_signals(before: dict | None, after: dict | None) -> dict | None:
    """Return {"changes": {signal: {"before", "after", "change"}}, "worsened": [...]}.

    `changes` lists every signal present in either snapshot; `change` is
    after - before for numeric signals with both values, else None. `worsened`
    names the error counters that increased, plus "smart_passed" if SMART's
    overall verdict went from passed to failed. None if either snapshot is missing.
    """
    if not before or not after:
        return None
    changes = {}
    for name in sorted(before.keys() | after.keys()):
        b, a = before.get(name), after.get(name)
        numeric = isinstance(b, (int, float)) and isinstance(a, (int, float)) and not isinstance(b, bool)
        changes[name] = {"before": b, "after": a, "change": a - b if numeric else None}

    worsened = [
        name for name in WORSENING_COUNTERS
        if (changes.get(name) or {}).get("change") is not None and changes[name]["change"] > 0
    ]
    if before.get("smart_passed") is True and after.get("smart_passed") is False:
        worsened.append("smart_passed")
    return {"changes": changes, "worsened": worsened}
