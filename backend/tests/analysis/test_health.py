import pytest

from analysis.health import (
    HEALTH_BANDS, SIGNAL_FACTORS, SIGNAL_THRESHOLDS, score_health, score_signals, status_for,
)
from drives.drive_models import DCSignals


def _ok(**kw):
    return DCSignals(smart_passed=True, **kw)


def _factor(health, key):
    return next(f for f in health.factors if f["key"] == key)


# ── bands ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("score,status", [
    (100, "Healthy"), (95, "Healthy"), (94, "Aging"), (80, "Aging"), (79, "Degraded"),
    (40, "Degraded"), (39, "Failing"), (15, "Failing"), (14, "Critical"), (1, "Critical"),
])
def test_status_bands(score, status):
    assert status_for(score) == status


def test_no_verdict_is_unrated():
    health = score_health(DCSignals(reallocated=5))
    assert (health.health_pct, health.health_status, health.factors) == (None, None, [])
    assert health.signal_flags["reallocated"] == "warn"


def test_clean_drive_is_100_with_no_factors():
    health = score_health(_ok(reallocated=0, pending=0, power_on_hours=20_000, temp=30))
    assert (health.health_pct, health.health_status, health.factors) == (100, "Healthy", [])
    assert set(health.signal_flags.values()) == {"ok"}


# ── the drive's own verdict ─────────────────────────────────────────────────

def test_drive_saying_it_is_failing_is_critical():
    health = score_health(DCSignals(smart_passed=False))
    assert health.health_status == "Critical"
    assert health.signal_flags["smart_passed"] == "crit"
    assert _factor(health, "drive_verdict")["role"] == "start"


def test_sas_verdict_names_the_drives_reason_once():
    extras = {"smart_attributes": [{
        "key": "smart_status", "label": "SMART Overall Status", "value": "FAILED",
        "detail": "Data channel impending failure data error rate too high", "drive_report": "failed",
    }]}
    health = score_health(DCSignals(smart_passed=False), extras)
    verdicts = [f for f in health.factors if f["kind"] == "drive"]
    assert [f["value"] for f in verdicts] == ["Data channel impending failure data error rate too high"]


def test_attribute_failing_now_is_critical_even_with_a_passing_verdict():
    extras = {"smart_attributes": [{
        "key": "ata_3", "label": "Spin Up Time", "value": "0", "drive_report": None,
        "metric": {"kind": "normalized_value", "measured": 20, "drive_threshold": 21},
    }]}
    health = score_health(_ok(), extras)
    assert health.health_status == "Critical"
    assert "Spin Up Time" in _factor(health, "drive_verdict")["value"]


def test_attribute_failed_in_the_past_is_degraded_but_old_heat_is_not():
    past = {"key": "ata_3", "label": "Spin Up Time", "value": "0", "drive_report": "past"}
    heat = {"key": "ata_190", "label": "Airflow Temperature Cel", "value": "30", "drive_report": "past", "signal": "temp"}
    assert score_health(_ok(), {"smart_attributes": [past]}).health_status == "Degraded"
    assert score_health(_ok(), {"smart_attributes": [heat]}).health_status == "Healthy"


def test_only_the_latest_self_test_failing_counts():
    failed = {"key": "t0", "label": "Extended offline", "value": "Completed: read failure", "drive_report": "failed"}
    passed = {"key": "t0", "label": "Extended offline", "value": "Completed without error", "drive_report": "ok"}
    assert score_health(_ok(), {"self_test_log": [failed, passed]}).health_status == "Failing"
    assert score_health(_ok(), {"self_test_log": [passed, failed]}).health_status == "Healthy"


# ── media ───────────────────────────────────────────────────────────────────

def test_one_reallocated_sector_is_degraded():
    health = score_health(_ok(reallocated=1))
    assert (health.health_pct, health.health_status) == (79, "Degraded")
    assert health.signal_flags["reallocated"] == "warn"


@pytest.mark.parametrize("signal", ["pending", "uncorrected", "reallocated"])
def test_media_counts_fall_with_each_tenfold(signal):
    scores = [score_health(_ok(**{signal: n})).health_pct for n in (1, 10, 100, 1000)]
    assert scores == sorted(scores, reverse=True) and len(set(scores)) == 4
    assert scores[0] < HEALTH_BANDS["aging_gte"]


def test_heavy_pending_is_failing_and_thousands_critical():
    assert score_health(_ok(pending=108)).health_status == "Failing"
    assert score_health(_ok(pending=5000)).health_status == "Critical"
    assert score_health(_ok(pending=108)).signal_flags["pending"] == "crit"


# ── combining ───────────────────────────────────────────────────────────────

def test_worst_factor_starts_and_others_lower_it():
    health = score_health(_ok(pending=108, uncorrected=7, reallocated=5, power_on_hours=53_647))
    start, *rest = health.factors
    assert (start["key"], start["role"]) == ("pending", "start")
    assert health.health_pct < start["standalone"]
    assert all(f["role"] == "adds" and f["points"] <= 0 for f in rest)
    assert health.health_status == "Failing"


def test_a_comorbidity_takes_its_weights_share_of_its_lost_health():
    alone = score_health(_ok(reallocated=1)).health_pct
    both = score_health(_ok(reallocated=1, power_on_hours=70_000))
    poh = _factor(both, "power_on_hours")
    expected = alone * (1 - SIGNAL_FACTORS["power_on_hours"].weight * (100 - poh["standalone"]) / 100)
    assert both.health_pct == round(expected)


def test_score_never_reaches_zero_for_a_drive_that_answers():
    health = score_health(DCSignals(smart_passed=False, pending=50_000, uncorrected=50_000, reallocated=50_000))
    assert health.health_pct >= 1


# ── wear and environment ────────────────────────────────────────────────────

def test_old_clean_drive_is_aging_not_degraded():
    health = score_health(_ok(power_on_hours=67_000, reallocated=0))
    assert health.health_status == "Aging"
    assert health.signal_flags["power_on_hours"] == "warn"


def test_age_and_wear_alone_never_go_below_aging():
    health = score_health(_ok(power_on_hours=200_000, load_unload_cycles=5_000_000, temp=70))
    assert (health.health_pct, health.floor) == (80, 80)


def test_heat_alone_stays_healthy():
    health = score_health(_ok(temp=60))
    assert (health.health_status, health.floor) == ("Healthy", 95)
    assert health.signal_flags["temp"] == "warn"


def test_wear_is_never_flagged_crit():
    flags = score_health(_ok(power_on_hours=500_000, load_unload_cycles=9_000_000)).signal_flags
    assert (flags["power_on_hours"], flags["load_unload_cycles"]) == ("warn", "warn")


def test_rated_cycle_count_is_judged_against_the_drives_own_rating():
    extras = {"smart_attributes": [{
        "key": "load_unload_cycles", "label": "Load/Unload Cycles", "value": "300,000 / 300,000",
        "signal": "load_unload_cycles",
        "metric": {"kind": "rated_lifetime", "measured": 300_000, "drive_threshold": 300_000},
    }]}
    health = score_health(_ok(load_unload_cycles=300_000), extras)
    assert _factor(health, "load_unload_cycles")["value"] == "100% of rated"
    assert health.signal_flags["load_unload_cycles"] == "warn"
    # Without the rating, 300k is under the generic curve.
    assert score_health(_ok(load_unload_cycles=300_000)).signal_flags["load_unload_cycles"] == "ok"


# ── thresholds ──────────────────────────────────────────────────────────────

def test_thresholds_are_where_the_curves_cross():
    assert SIGNAL_THRESHOLDS["reallocated"] == {"warn_gte": 1, "crit_gte": 1001}
    assert SIGNAL_THRESHOLDS["power_on_hours"]["crit_gte"] is None
    for key, limits in SIGNAL_THRESHOLDS.items():
        if limits["warn_gte"] is not None:
            assert score_health(_ok(**{key: limits["warn_gte"]})).signal_flags[key] != "ok"
            assert score_health(_ok(**{key: limits["warn_gte"] - 1})).signal_flags[key] == "ok"


# ── stored facts ────────────────────────────────────────────────────────────

def test_score_signals_judges_a_stored_dict_like_the_live_drive():
    stored = {"smart_passed": True, "reallocated": 1, "power_on_hours": 70_000}
    live = score_health(_ok(reallocated=1, power_on_hours=70_000))
    assert score_signals(stored) == live


def test_score_signals_ignores_fields_dcsignals_no_longer_has():
    assert score_signals({"temp": 50, "retired_field": 7}).signal_flags["temp"] == "warn"
    assert score_signals(None).health_status is None
