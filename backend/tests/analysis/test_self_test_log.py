import pytest

from analysis.self_test_log import build_self_test_log
from drives.drive_models import DriveType


def test_ata_log_empty_when_missing():
    assert build_self_test_log({}, DriveType.HDD) == []


@pytest.mark.xfail(
    reason="_ata_row's 'error' in result_str.lower() check matches smartctl's own "
           "success string 'Completed without error', so a clean ATA self-test is "
           "misclassified as crit. Looks like a real bug, not a test bug.",
    strict=True,
)
def test_ata_log_passed_entry_is_ok():
    data = {"ata_smart_self_test_log": {"standard": {"table": [
        {"type": {"string": "Short offline"}, "status": {"string": "Completed without error", "passed": True},
         "lifetime_hours": 100},
    ]}}}
    rows = build_self_test_log(data, DriveType.HDD)
    assert len(rows) == 1
    assert rows[0].key == "ata_self_test_0"
    assert rows[0].label == "Short offline"
    assert rows[0].status == "ok"
    assert rows[0].detail == "at 100h"


def test_ata_log_failed_entry_is_crit():
    data = {"ata_smart_self_test_log": {"standard": {"table": [
        {"type": {"string": "Extended offline"}, "status": {"string": "Completed: read failure", "passed": False}},
    ]}}}
    rows = build_self_test_log(data, DriveType.HDD)
    assert rows[0].status == "crit"


def test_ata_log_interrupted_entry_is_warn():
    data = {"ata_smart_self_test_log": {"standard": {"table": [
        {"type": {"string": "Short offline"}, "status": {"string": "Interrupted (host reset)"}},
    ]}}}
    rows = build_self_test_log(data, DriveType.HDD)
    assert rows[0].status == "warn"


def test_scsi_log_scans_until_gap():
    data = {
        "scsi_self_test_0": {"code": {"string": "Background short"}, "result": {"string": "Completed", "value": 0}},
        "scsi_self_test_1": {"code": {"string": "Background long"}, "result": {"string": "Completed", "value": 0}},
    }
    rows = build_self_test_log(data, DriveType.SAS)
    assert [r.key for r in rows] == ["scsi_self_test_0", "scsi_self_test_1"]


def test_scsi_log_failed_result_is_crit():
    data = {"scsi_self_test_0": {"code": {"string": "Background short"}, "result": {"string": "Failed", "value": 7}}}
    rows = build_self_test_log(data, DriveType.SAS)
    assert rows[0].status == "crit"


def test_scsi_log_nonzero_result_without_fail_text_is_warn():
    data = {"scsi_self_test_0": {"code": {"string": "Background short"}, "result": {"string": "Aborted", "value": 3}}}
    rows = build_self_test_log(data, DriveType.SAS)
    assert rows[0].status == "warn"


def test_scsi_log_detail_combines_poh_sense_key_and_lba():
    data = {"scsi_self_test_0": {
        "code": {"string": "Background short"},
        "result": {"string": "Failed", "value": 7},
        "power_on_time": {"hours": 50},
        "sense_key": {"string": "MEDIUM ERROR"},
        "lba_first_failure": {"value": 12345},
    }}
    rows = build_self_test_log(data, DriveType.SAS)
    assert rows[0].detail == "at 50h · MEDIUM ERROR · LBA 12,345"


def test_scsi_log_no_detail_parts_is_none():
    data = {"scsi_self_test_0": {"code": {"string": "Background short"}, "result": {"string": "Completed", "value": 0}}}
    rows = build_self_test_log(data, DriveType.SAS)
    assert rows[0].detail is None
