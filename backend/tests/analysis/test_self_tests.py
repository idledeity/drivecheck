from analysis.self_tests import build_self_tests as _build

READ = "2026-03-01T00:00:00"
RECENT = {"short": 168, "long": 1000}


def build_self_tests(rows, poh, recent=RECENT, latest_read_at=None):
    return _build(rows, poh, recent, latest_read_at)


def _row(hours, type_code=2, report="ok", protocol="ata", last_seen=READ, first_seen="2026-01-01T00:00:00"):
    return {"protocol": protocol, "type_code": type_code, "type": "t", "result_code": 0, "result": "r",
            "drive_report": report, "power_on_hours": hours, "lba_first_failure": None,
            "first_seen_at": first_seen, "last_seen_at": last_seen}


def test_no_rows():
    assert build_self_tests([], 1000) == {
        "entries": [], "latest": {"short": None, "conveyance": None, "long": None}, "hours_reset": False,
        "log_seen_at": None, "log_missing": False}


def test_last_long_kept_after_short_tests_roll_it_out():
    rows = [_row(990, type_code=1), _row(980, type_code=3), _row(500, last_seen="2026-02-01T00:00:00")]
    view = build_self_tests(rows, 1000)
    assert [e["in_drive_log"] for e in view["entries"]] == [True, True, False]
    assert view["latest"]["long"]["power_on_hours"] == 500
    assert view["latest"]["long"]["age_hours"] == 500
    assert view["latest"]["long"]["in_drive_log"] is False


def test_aborted_long_is_skipped_failed_counts():
    view = build_self_tests([_row(900, report="marginal"), _row(800, report="failed"), _row(700)], 1000)
    assert view["latest"]["long"]["power_on_hours"] == 800


def test_long_codes_by_protocol():
    view = build_self_tests([_row(900, type_code=130), _row(800, type_code=6, protocol="scsi"),
                             _row(700, type_code=1, protocol="scsi")], 1000)
    assert [e["kind"] for e in view["entries"]] == ["long", "long", "short"]


def test_ata_hours_unwrapped_past_16_bits():
    # 70,000 h now: an entry logged at 3,000 (low 16 bits) ran at 68,536 h.
    view = build_self_tests([_row(3000)], 70000)
    assert view["entries"][0]["hours"] == 68536
    assert view["latest"]["long"]["age_hours"] == 1464


def test_scsi_hours_never_unwrapped():
    view = build_self_tests([_row(3000, type_code=2, protocol="scsi")], 70000)
    assert view["entries"][0]["age_hours"] == 67000


def test_hours_reset_leaves_old_entries_ageless_and_last():
    rows = [_row(40000, first_seen="2025-01-01T00:00:00", last_seen="2025-06-01T00:00:00"), _row(50, type_code=1)]
    view = build_self_tests(rows, 100)
    assert view["hours_reset"] is True
    assert [(e["power_on_hours"], e["age_hours"]) for e in view["entries"]] == [(50, 50), (40000, None)]
    assert view["latest"]["long"]["age_hours"] is None


def test_in_drive_log_against_the_newest_read_that_listed_entries():
    # Later reads without a log (a failing SAS drive's) don't roll entries out.
    view = build_self_tests([_row(900, last_seen="2026-02-01T00:00:00"), _row(500, last_seen="2026-01-01T00:00:00")], 1000)
    assert [e["in_drive_log"] for e in view["entries"]] == [True, False]


def test_no_current_hours_no_ages():
    view = build_self_tests([_row(900)], None)
    assert view["entries"][0]["age_hours"] is None and view["hours_reset"] is False


def test_latest_of_each_kind_and_recent_by_window():
    rows = [_row(990, type_code=1), _row(950, type_code=3), _row(900, type_code=4), _row(100)]
    view = build_self_tests(rows, 1000)
    latest = view["latest"]
    assert (latest["short"]["age_hours"], latest["short"]["recent"]) == (10, True)
    assert latest["conveyance"]["recent"] is None         # no window for conveyance
    assert (latest["long"]["age_hours"], latest["long"]["recent"]) == (900, True)
    assert build_self_tests(rows, 1200)["latest"]["long"]["recent"] is False   # 1,100 h > 1,000


def test_a_failed_test_is_the_latest_of_its_kind():
    view = build_self_tests([_row(990, type_code=1, report="failed"), _row(980, type_code=1)], 1000)
    assert view["latest"]["short"]["drive_report"] == "failed"


def test_captive_and_foreground_kinds():
    view = build_self_tests([_row(9, type_code=129), _row(8, type_code=131), _row(7, type_code=5, protocol="scsi")], 10)
    assert [e["kind"] for e in view["entries"]] == ["short", "conveyance", "short"]


def test_log_missing_when_the_latest_read_listed_no_tests():
    rows = [_row(900, type_code=1)]
    assert build_self_tests(rows, 1000, latest_read_at=READ)["log_missing"] is False
    view = build_self_tests(rows, 1000, latest_read_at="2026-03-02T00:00:00")
    assert (view["log_missing"], view["log_seen_at"]) == (True, READ)
    assert build_self_tests([], 1000, latest_read_at=READ)["log_missing"] is False   # never listed any
