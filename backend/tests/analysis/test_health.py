from analysis.health import score_health, SIGNAL_WEIGHTS, SMART_FAIL_CAP
from drives.drive_models import DCSignals


ALL_OK_FLAGS = {
    "reallocated": "ok", "pending": "ok", "uncorrected": "ok",
    "crc_errors": "ok", "power_on_hours": "ok", "load_unload_cycles": "ok", "temp": "ok",
}


def test_smart_failed_overrides_everything():
    signals = DCSignals(smart_passed=False, reallocated=0, uncorrected=0)
    health = score_health(signals)
    assert health.health_status == "Failing"
    assert health.health_pct == SMART_FAIL_CAP


def test_reallocated_sectors_means_degraded():
    signals = DCSignals(smart_passed=True, reallocated=1)
    health = score_health(signals)
    assert health.health_status == "Degraded"
    assert health.health_pct == 100 - SIGNAL_WEIGHTS["reallocated"]["warn"]
    assert health.signal_flags["reallocated"] == "warn"


def test_uncorrected_errors_means_degraded():
    signals = DCSignals(smart_passed=True, uncorrected=1)
    health = score_health(signals)
    assert health.health_status == "Degraded"
    assert health.health_pct == 100 - SIGNAL_WEIGHTS["uncorrected"]["crit"]
    assert health.signal_flags["uncorrected"] == "crit"


def test_smart_passed_with_no_flags_is_healthy():
    signals = DCSignals(smart_passed=True, reallocated=0, uncorrected=0, pending=0, temp=30)
    health = score_health(signals)
    assert health.health_status == "Healthy"
    assert health.health_pct == 100
    assert health.signal_flags == ALL_OK_FLAGS


def test_smart_passed_unknown_is_unrated():
    signals = DCSignals(smart_passed=None)
    health = score_health(signals)
    assert health.health_status is None
    assert health.health_pct is None


def test_high_temp_flags_warn_but_does_not_change_status():
    signals = DCSignals(smart_passed=True, reallocated=0, uncorrected=0, temp=50)
    health = score_health(signals)
    assert health.signal_flags["temp"] == "warn"
    assert health.health_status == "Healthy"
    assert health.health_pct == 100 - SIGNAL_WEIGHTS["temp"]["warn"]


def test_score_deducts_all_active_signals():
    signals = DCSignals(smart_passed=True, reallocated=1, pending=1, crc_errors=1)
    health = score_health(signals)
    expected = (
        100
        - SIGNAL_WEIGHTS["reallocated"]["warn"]
        - SIGNAL_WEIGHTS["pending"]["warn"]
        - SIGNAL_WEIGHTS["crc_errors"]["warn"]
    )
    assert health.health_pct == expected


def test_smart_fail_cap_applies_even_with_no_signal_flags():
    signals = DCSignals(smart_passed=False)
    health = score_health(signals)
    assert health.health_pct == SMART_FAIL_CAP
    assert health.health_status == "Failing"


def test_score_cannot_go_below_zero():
    # Worst possible: smart failed and every signal is crit
    signals = DCSignals(
        smart_passed=False,
        reallocated=999, pending=999, uncorrected=999,
        crc_errors=999, power_on_hours=999_999, load_unload_cycles=999_999, temp=99,
    )
    health = score_health(signals)
    assert health.health_pct >= 0


def test_old_age_triggers_power_on_hours_flag():
    signals = DCSignals(smart_passed=True, power_on_hours=45_000)
    health = score_health(signals)
    assert health.signal_flags["power_on_hours"] == "warn"
    assert health.health_pct == 100 - SIGNAL_WEIGHTS["power_on_hours"]["warn"]
