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
WORSENING_COUNTERS = ("reallocated", "pending", "uncorrected", "crc_errors", "reallocated_events", "link_errors")


def compare_signals(before: dict | None, after: dict | None) -> dict | None:
    """Return {"changes": {signal: {"before", "after", "change"}}, "worsened": [...],
    "uncompared": [...]}.

    `changes` lists every signal present in either snapshot; `change` is
    after - before for numeric signals with both values, else None. `worsened`
    names the error counters that increased, plus "smart_passed" if SMART's
    overall verdict went from passed to failed. `uncompared` names the error
    counters reported in only one snapshot: they can't be said to have held
    steady, so callers must not report a clean run for them. None if either
    snapshot is missing.
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
    uncompared = [
        name for name in WORSENING_COUNTERS
        if name in changes and changes[name]["change"] is None
        and (changes[name]["before"] is not None or changes[name]["after"] is not None)
    ]
    return {"changes": changes, "worsened": worsened, "uncompared": uncompared}


def compare_span(steps: list[tuple[int, dict | None, dict | None]]) -> dict | None:
    """Compare a batch's SMART across its steps so far: the first step's
    "before" against the "after" of the last step that has one, given the
    steps as (step, smart_before, smart_after) in step order.

    Uses the two ends rather than adding up each step's changes, so anything
    that changed between steps (a gap long enough for a step to take its own
    "before") is counted too. Returns compare_signals() trimmed to the error
    counters and smart_passed, plus "from_step"/"to_step"; None if no step has
    a usable "before" followed by a usable "after".
    """
    first = next(((s, b) for s, b, _ in steps if _signals(b) is not None), None)
    last = next(((s, a) for s, _, a in reversed(steps) if _signals(a) is not None), None)
    if first is None or last is None or last[0] < first[0]:
        return None
    comparison = compare_signals(_signals(first[1]), _signals(last[1]))
    keep = set(WORSENING_COUNTERS) | {"smart_passed"}
    comparison["changes"] = {k: v for k, v in comparison["changes"].items() if k in keep}
    return {**comparison, "from_step": first[0], "to_step": last[0]}


def _signals(snapshot: dict | None) -> dict | None:
    """A stored snapshot summary's signals, or None if missing or failed."""
    if not snapshot or "error" in snapshot:
        return None
    return snapshot.get("signals") or None
