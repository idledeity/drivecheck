from analysis.severity import flag


def test_none_value_is_ok():
    assert flag(None, warn_gte=1, crit_gte=2) == "ok"


def test_below_warn_threshold_is_ok():
    assert flag(0, warn_gte=1, crit_gte=2) == "ok"


def test_at_warn_threshold_is_warn():
    assert flag(1, warn_gte=1, crit_gte=2) == "warn"


def test_at_crit_threshold_is_crit():
    assert flag(2, warn_gte=1, crit_gte=2) == "crit"


def test_above_crit_threshold_is_crit():
    assert flag(100, warn_gte=1, crit_gte=2) == "crit"


def test_no_thresholds_set_is_always_ok():
    assert flag(1000) == "ok"


def test_only_crit_threshold_set():
    assert flag(5, crit_gte=10) == "ok"
    assert flag(10, crit_gte=10) == "crit"
