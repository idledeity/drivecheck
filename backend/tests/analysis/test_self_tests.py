from analysis.self_tests import build_self_tests

READ = "2026-03-01T00:00:00"


def _row(hours, type_code=2, report="ok", protocol="ata", last_seen=READ, first_seen="2026-01-01T00:00:00"):
    return {"protocol": protocol, "type_code": type_code, "type": "t", "result_code": 0, "result": "r",
            "drive_report": report, "power_on_hours": hours, "lba_first_failure": None,
            "first_seen_at": first_seen, "last_seen_at": last_seen}


def test_no_rows():
    assert build_self_tests([], 1000) == {"entries": [], "last_extended": None, "hours_reset": False}


def test_last_extended_kept_after_short_tests_roll_it_out():
    rows = [_row(990, type_code=1), _row(980, type_code=3), _row(500, last_seen="2026-02-01T00:00:00")]
    view = build_self_tests(rows, 1000, READ)
    assert [e["in_drive_log"] for e in view["entries"]] == [True, True, False]
    assert view["last_extended"]["power_on_hours"] == 500
    assert view["last_extended"]["age_hours"] == 500
    assert view["last_extended"]["in_drive_log"] is False


def test_aborted_extended_is_skipped_failed_counts():
    view = build_self_tests([_row(900, report="marginal"), _row(800, report="failed"), _row(700)], 1000, READ)
    assert view["last_extended"]["power_on_hours"] == 800


def test_extended_codes_by_protocol():
    view = build_self_tests([_row(900, type_code=130), _row(800, type_code=6, protocol="scsi"),
                             _row(700, type_code=1, protocol="scsi")], 1000, READ)
    assert [e["extended"] for e in view["entries"]] == [True, True, False]


def test_ata_hours_unwrapped_past_16_bits():
    # 70,000 h now: an entry logged at 3,000 (low 16 bits) ran at 68,536 h.
    view = build_self_tests([_row(3000)], 70000, READ)
    assert view["entries"][0]["hours"] == 68536
    assert view["last_extended"]["age_hours"] == 1464


def test_scsi_hours_never_unwrapped():
    view = build_self_tests([_row(3000, type_code=2, protocol="scsi")], 70000, READ)
    assert view["entries"][0]["age_hours"] == 67000


def test_hours_reset_leaves_old_entries_ageless_and_last():
    rows = [_row(40000, first_seen="2025-01-01T00:00:00", last_seen="2025-06-01T00:00:00"), _row(50, type_code=1)]
    view = build_self_tests(rows, 100, READ)
    assert view["hours_reset"] is True
    assert [(e["power_on_hours"], e["age_hours"]) for e in view["entries"]] == [(50, 50), (40000, None)]
    assert view["last_extended"]["age_hours"] is None


def test_latest_read_defaults_to_newest_last_seen():
    view = build_self_tests([_row(900), _row(500, last_seen="2026-02-01T00:00:00")], 1000)
    assert [e["in_drive_log"] for e in view["entries"]] == [True, False]


def test_no_current_hours_no_ages():
    view = build_self_tests([_row(900)], None, READ)
    assert view["entries"][0]["age_hours"] is None and view["hours_reset"] is False
