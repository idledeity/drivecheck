"""Comparing SMART signals from before and after a job."""

from analysis.smart_delta import compare_signals, compare_span

BEFORE = {"power_on_hours": 20512, "temp": 31, "reallocated": 0, "pending": 0, "uncorrected": 0,
          "crc_errors": 2, "reallocated_events": 0, "load_unload_cycles": None, "smart_passed": True}


def test_missing_side_gives_no_comparison():
    assert compare_signals(BEFORE, None) is None
    assert compare_signals(None, BEFORE) is None


def test_unchanged_run_has_nothing_worsened():
    after = {**BEFORE, "power_on_hours": 20534, "temp": 38}
    result = compare_signals(BEFORE, after)
    assert result["worsened"] == []
    assert result["uncompared"] == []  # load_unload_cycles isn't an error counter; null on both sides is fine
    assert result["changes"]["power_on_hours"] == {"before": 20512, "after": 20534, "change": 22}
    assert result["changes"]["load_unload_cycles"] == {"before": None, "after": None, "change": None}


def test_rising_error_counters_are_worsened_in_a_fixed_order():
    after = {**BEFORE, "pending": 4, "reallocated": 8, "crc_errors": 3}
    assert compare_signals(BEFORE, after)["worsened"] == ["reallocated", "pending", "crc_errors"]


def test_falling_counter_is_not_worsened():
    # e.g. pending sectors cleared by a write pass
    assert compare_signals({**BEFORE, "pending": 4}, BEFORE)["worsened"] == []


def test_smart_failing_during_the_run_is_worsened():
    result = compare_signals(BEFORE, {**BEFORE, "smart_passed": False})
    assert result["worsened"] == ["smart_passed"]
    assert result["changes"]["smart_passed"]["change"] is None  # booleans have no numeric change


def test_counter_appearing_only_after_has_no_change():
    result = compare_signals({"reallocated": None}, {"reallocated": 3})
    assert result["changes"]["reallocated"]["change"] is None
    assert result["worsened"] == []
    assert result["uncompared"] == ["reallocated"]


def test_counter_missing_after_is_uncompared():
    result = compare_signals(BEFORE, {**BEFORE, "pending": None})
    assert result["worsened"] == []
    assert result["uncompared"] == ["pending"]


def _snap(**signals):
    return {"snapshot_id": 1, "captured_at": "2026-01-01T00:00:00+00:00", "signals": {**BEFORE, **signals}}


def test_span_compares_first_before_with_last_after_not_the_sum_of_steps():
    # Sectors remapped between steps 0 and 1 (step 1 took its own "before")
    # still count: the span runs from step 0's before to step 2's after.
    steps = [(0, _snap(), _snap()), (1, _snap(reallocated=3), _snap(reallocated=3)), (2, _snap(reallocated=3), _snap(reallocated=5, pending=1))]
    span = compare_span(steps)
    assert (span["from_step"], span["to_step"]) == (0, 2)
    assert span["worsened"] == ["reallocated", "pending"]
    assert span["changes"]["reallocated"] == {"before": 0, "after": 5, "change": 5}


def test_span_keeps_only_error_counters_and_verdict():
    span = compare_span([(0, _snap(), _snap(temp=40))])
    assert set(span["changes"]) == {"reallocated", "pending", "uncorrected", "crc_errors", "reallocated_events", "smart_passed"}


def test_span_skips_steps_without_snapshots():
    # Step 0's capture failed, step 2 was skipped: compare step 1's before with its own after.
    steps = [(0, {"error": "timeout"}, None), (1, _snap(), _snap(pending=2)), (2, None, None)]
    span = compare_span(steps)
    assert (span["from_step"], span["to_step"], span["worsened"]) == (1, 1, ["pending"])


def test_span_is_none_before_any_step_finished():
    assert compare_span([]) is None
    assert compare_span([(0, _snap(), None), (1, None, None)]) is None
