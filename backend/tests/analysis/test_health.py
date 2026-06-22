from analysis.health import score_health
from drives.drive_models import DCSignals


def test_smart_failed_overrides_everything():
    signals = DCSignals(smart_passed=False, reallocated=0, uncorrected=0)
    health = score_health(signals)
    assert health.health_status == "Failing"


def test_reallocated_sectors_means_degraded():
    signals = DCSignals(smart_passed=True, reallocated=1)
    health = score_health(signals)
    assert health.health_status == "Degraded"
    assert health.signal_flags["reallocated"] == "warn"


def test_uncorrected_errors_means_degraded():
    signals = DCSignals(smart_passed=True, uncorrected=1)
    health = score_health(signals)
    assert health.health_status == "Degraded"
    assert health.signal_flags["uncorrected"] == "crit"


def test_smart_passed_with_no_flags_is_healthy():
    signals = DCSignals(smart_passed=True, reallocated=0, uncorrected=0, pending=0, temp=30)
    health = score_health(signals)
    assert health.health_status == "Healthy"
    assert health.signal_flags == {"reallocated": "ok", "pending": "ok", "uncorrected": "ok", "temp": "ok"}


def test_smart_passed_unknown_is_unrated():
    signals = DCSignals(smart_passed=None)
    health = score_health(signals)
    assert health.health_status is None


def test_high_temp_flags_warn_but_does_not_change_status():
    signals = DCSignals(smart_passed=True, reallocated=0, uncorrected=0, temp=50)
    health = score_health(signals)
    assert health.signal_flags["temp"] == "warn"
    assert health.health_status == "Healthy"
