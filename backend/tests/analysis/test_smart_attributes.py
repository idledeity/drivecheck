from analysis.smart_attributes import judge_report, judge_row


def _fact(**inputs):
    return {"key": "k", "label": "Label", "value": "1", "detail": None,
            "signal": None, "metric": None, "drive_report": None, **inputs}


def _status(signal_flags=None, **inputs):
    return judge_row(_fact(**inputs), signal_flags or {})["status"]


def test_a_row_with_no_judging_inputs_is_ok():
    assert _status() == "ok"


def test_a_row_takes_its_signal_s_flag():
    assert _status({"temp": "warn"}, signal="temp") == "warn"
    assert _status({}, signal="temp") == "ok"


def test_drive_report_maps_to_severity():
    assert _status(drive_report="failed") == "crit"
    assert _status(drive_report="marginal") == "warn"
    assert _status(drive_report="ok") == "ok"


def test_metric_rules():
    m = lambda kind, measured, t=None: {"kind": kind, "measured": measured, "drive_threshold": t}
    assert _status(metric=m("normalized_value", 5, 10)) == "crit"
    assert _status(metric=m("normalized_value", 5, 0)) == "ok"      # 0 = the drive sets no threshold
    assert _status(metric=m("rated_lifetime", 7999, 10000)) == "ok"
    assert _status(metric=m("rated_lifetime", 8000, 10000)) == "warn"
    assert _status(metric=m("rated_lifetime", 10000, 10000)) == "crit"
    assert _status(metric=m("rated_lifetime", 10000, None)) == "ok"
    assert _status(metric=m("available_spare", 10, 10)) == "warn"
    assert _status(metric=m("available_spare", 11, 10)) == "ok"
    assert _status(metric=m("percentage_used", 80)) == "warn"
    assert _status(metric=m("percentage_used", 100)) == "crit"
    assert _status(metric=m("error_log_entries", 1)) == "warn"


def test_an_unknown_metric_is_not_judged():
    assert _status(metric={"kind": "from_a_future_probe", "measured": 99, "drive_threshold": None}) == "ok"


def test_an_unreadable_stored_metric_is_skipped_not_raised():
    assert _status(metric={"name": "rated_lifetime", "value": 1}) == "ok"


def test_a_row_takes_the_worst_of_its_inputs():
    assert _status({"reallocated": "warn"}, signal="reallocated", drive_report="failed") == "crit"
    assert _status({"reallocated": "crit"}, signal="reallocated", drive_report="ok") == "crit"


def test_judged_row_has_the_served_shape_without_judging_inputs():
    assert judge_row(_fact(signal="temp", detail="d"), {"temp": "warn"}) == {
        "key": "k", "label": "Label", "value": "1", "status": "warn", "detail": "d",
    }


def test_a_minimal_fact_from_a_simple_probe_is_judged_ok():
    assert judge_row({"key": "k", "label": "L", "value": "v"}, {})["status"] == "ok"


def test_a_row_stored_with_a_status_by_an_older_version_is_kept_as_stored():
    legacy = {"key": "ata_5", "label": "Reallocated Sector Ct", "value": "0", "status": "crit", "detail": None}
    assert judge_row(legacy, {"reallocated": "ok"}) is legacy


def test_judge_report_uses_the_report_s_own_signals():
    raw = {
        "signals": {"power_on_hours": 51327},
        "smart_attributes": [_fact(signal="power_on_hours")],
        "self_test_log": [_fact(drive_report="failed")],
        "smartctl": {"untouched": True},
    }
    judged = judge_report(raw)
    assert judged["smart_attributes"][0]["status"] == "warn"
    assert judged["self_test_log"][0]["status"] == "crit"
    assert judged["smartctl"] == {"untouched": True}
    assert "status" not in raw["smart_attributes"][0]    # the stored report isn't modified


def test_judge_report_falls_back_to_given_signals_for_a_report_stored_without_them():
    raw = {"smart_attributes": [_fact(signal="power_on_hours")]}
    assert judge_report(raw, {"power_on_hours": 61000})["smart_attributes"][0]["status"] == "crit"
    assert judge_report(raw)["smart_attributes"][0]["status"] == "ok"
