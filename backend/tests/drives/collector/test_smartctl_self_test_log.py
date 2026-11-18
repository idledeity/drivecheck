# Parse -> judge, end to end: the statuses the SMART tab shows for the drive's self-test log.
from dataclasses import asdict
from types import SimpleNamespace

from analysis.smart_attributes import judge_row
from drives.collector.probes.telemetry.smartctl_self_test_log import parse_self_test_log
from drives.drive_models import DriveType


def build_self_test_log(data, drive_type):
    return [SimpleNamespace(**judge_row(asdict(f), {})) for f in parse_self_test_log(data, drive_type)]


def test_ata_log_empty_when_missing():
    assert build_self_test_log({}, DriveType.HDD) == []


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


# ── observed_self_tests: plain entries for drive_self_tests (real output) ──

import json  # noqa: E402
from pathlib import Path  # noqa: E402

from drives.collector.probes.telemetry.smartctl_self_test_log import observed_self_tests  # noqa: E402

_FULL_X = json.loads((Path(__file__).parents[2] / "analysis" / "fixtures" / "smartctl_full_reads_x.json").read_text())
_SELFTEST = Path(__file__).parents[2] / "operations" / "fixtures"
_ATA_RUN = json.loads((_SELFTEST / "smart_ata_short_selftest.json").read_text())
_SAS_RUN = json.loads((_SELFTEST / "smart_sas_short_selftest.json").read_text())


def test_observed_ata_entry_from_standard_and_extended_logs_once():
    # The Exos lists its one short test in both the standard and extended log.
    assert observed_self_tests(_FULL_X["exos_x16"]) == [{
        "protocol": "ata", "type_code": 1, "type": "Short offline", "result_code": 0,
        "result": "Completed without error", "drive_report": "ok", "power_on_hours": 20513,
        "lba_first_failure": None,
    }]


def test_observed_ata_empty_log():
    assert observed_self_tests(_FULL_X["hp_mb3000gcvbt"]) == []


def test_observed_scsi_entries_newest_first():
    entries = observed_self_tests(_FULL_X["hgst_hus726060_sas"])
    assert [(e["protocol"], e["type_code"], e["type"], e["power_on_hours"], e["drive_report"])
            for e in entries[:2]] == [("scsi", 2, "Background long", 31278, "ok"),
                                      ("scsi", 1, "Background short", 31166, "ok")]


def test_observed_scsi_aborted_is_marginal():
    entries = observed_self_tests(_SAS_RUN["completed"])
    assert entries[1]["result"] == "Aborted (by user command)"
    assert entries[1]["drive_report"] == "marginal"


def test_observed_skips_tests_still_running():
    assert observed_self_tests(_ATA_RUN["running"]) == []    # status 249, in progress
    running = observed_self_tests(_SAS_RUN["running"])       # result 15, no hours yet
    assert running == observed_self_tests(_SAS_RUN["completed"])[1:]


def test_observed_entry_once_finished():
    [entry] = observed_self_tests(_ATA_RUN["completed"])
    assert (entry["result_code"], entry["drive_report"], entry["power_on_hours"]) == (0, "ok", 20513)
