import logging

from system_utils.logging.logger import LogLevel


def test_severity_ordering():
    assert LogLevel.DEBUG < LogLevel.INFO < LogLevel.WARNING < LogLevel.ERROR < LogLevel.CRITICAL


def test_to_stdlib_matches_standard_library_levels():
    assert LogLevel.DEBUG.to_stdlib() == logging.DEBUG
    assert LogLevel.WARNING.to_stdlib() == logging.WARNING
    assert LogLevel.CRITICAL.to_stdlib() == logging.CRITICAL


def test_from_stdlib_resolves_back():
    assert LogLevel.from_stdlib(logging.ERROR) == LogLevel.ERROR
    assert LogLevel.from_stdlib(logging.DEBUG) == LogLevel.DEBUG


def test_from_name_is_case_insensitive():
    assert LogLevel.from_name("warning") == LogLevel.WARNING
    assert LogLevel.from_name("WARNING") == LogLevel.WARNING
    assert LogLevel.from_name("  info  ") == LogLevel.INFO


def test_from_name_resolves_abbreviated_forms():
    assert LogLevel.from_name("WARN") == LogLevel.WARNING
    assert LogLevel.from_name("CRIT") == LogLevel.CRITICAL


def test_from_name_unknown_returns_none():
    assert LogLevel.from_name("nonsense") is None
