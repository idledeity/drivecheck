from datetime import UTC, datetime

import pytest

from system_utils import clock


def test_now_is_aware_utc():
    assert clock.now().tzinfo is UTC


def test_iso_writes_utc_with_an_offset_and_refuses_naive_times():
    assert clock.iso(datetime(2026, 11, 22, 20, 0, tzinfo=UTC)) == "2026-11-22T20:00:00+00:00"
    with pytest.raises(ValueError):
        clock.iso(datetime(2026, 11, 22, 20, 0))


def test_parse_reads_offsets_and_reads_a_legacy_naive_time_as_local(local_zone):
    local_zone("America/Chicago")
    assert clock.parse("2026-11-22T20:00:00+00:00") == datetime(2026, 11, 22, 20, 0, tzinfo=UTC)
    assert clock.parse("2026-11-22T20:00:00Z") == datetime(2026, 11, 22, 20, 0, tzinfo=UTC)
    assert clock.parse("2026-11-22T14:00:00") == datetime(2026, 11, 22, 20, 0, tzinfo=UTC)     # CST
    assert clock.parse("2026-10-22T14:00:00") == datetime(2026, 10, 22, 19, 0, tzinfo=UTC)     # CDT


def test_stored_strings_sort_as_text_in_time_order():
    times = [datetime(2026, 1, 1, 0, 0, 0, us, tzinfo=UTC) for us in (0, 1, 500000)]
    assert sorted(clock.iso(t) for t in times) == [clock.iso(t) for t in times]
