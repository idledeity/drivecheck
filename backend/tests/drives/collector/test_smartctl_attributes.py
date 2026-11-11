# Parse -> judge, end to end: the statuses the SMART attributes tab shows for
# smartctl output, with the given signal flags (as analysis.health would set).
from dataclasses import asdict
from types import SimpleNamespace

from analysis.smart_attributes import judge_row
from drives.collector.probes.telemetry.smartctl_attributes import parse_attributes
from drives.drive_models import DriveType


def _judged(data, drive_type, **signal_flags):
    return [SimpleNamespace(**judge_row(asdict(f), signal_flags)) for f in parse_attributes(data, drive_type)]


def test_empty_data_returns_no_rows_for_nvme_and_ata():
    for drive_type in (DriveType.NVME, DriveType.HDD):
        assert _judged({}, drive_type) == []


def test_empty_data_still_emits_a_default_scsi_smart_status_row():
    # _scsi_rows appends the smart_status row unconditionally, unlike every
    # other SCSI row which is gated on the relevant data being present.
    rows = _judged({}, DriveType.SAS)
    assert [r.key for r in rows] == ["smart_status"]
    assert rows[0].value == "—"
    assert rows[0].status == "ok"


def test_ata_row_reuses_signal_flags_for_mapped_attribute():
    data = {"ata_smart_attributes": {"table": [
        {"id": 5, "name": "Reallocated_Sector_Ct", "raw": {"string": "0", "value": 0},
         "value": 100, "worst": 100, "thresh": 10},
    ]}}
    rows = _judged(data, DriveType.HDD, reallocated="warn")
    assert len(rows) == 1
    assert rows[0].key == "ata_5"
    assert rows[0].label == "Reallocated Sector Ct"
    assert rows[0].status == "warn"


def test_ata_row_below_threshold_is_crit_when_unmapped():
    data = {"ata_smart_attributes": {"table": [
        {"id": 3, "name": "Spin_Up_Time", "raw": {"string": "100"},
         "value": 5, "worst": 5, "thresh": 10},
    ]}}
    rows = _judged(data, DriveType.HDD)
    assert rows[0].status == "crit"


def test_ata_row_when_failed_is_crit():
    data = {"ata_smart_attributes": {"table": [
        {"id": 3, "name": "Spin_Up_Time", "raw": {"string": "100"},
         "value": 100, "worst": 100, "thresh": 0, "when_failed": "in_the_past"},
    ]}}
    rows = _judged(data, DriveType.HDD)
    assert rows[0].status == "crit"


def test_scsi_smart_status_row():
    data = {"smart_status": {"passed": False, "scsi": {"ie_string": "FAILURE PREDICTION THRESHOLD EXCEEDED"}}}
    rows = _judged(data, DriveType.SAS)
    row = next(r for r in rows if r.key == "smart_status")
    assert row.value == "FAILED"
    assert row.status == "crit"
    assert row.detail == "FAILURE PREDICTION THRESHOLD EXCEEDED"


def test_scsi_temperature_row_uses_health_flag():
    data = {"temperature": {"current": 55, "drive_trip": 65}}
    rows = _judged(data, DriveType.SAS, temp="warn")
    row = next(r for r in rows if r.key == "temperature")
    assert row.value == "55°C"
    assert row.status == "warn"
    assert row.detail == "Trip threshold 65°C"


def test_scsi_uncorrected_errors_sums_read_write_verify():
    data = {"scsi_error_counter_log": {
        "read": {"total_uncorrected_errors": 1},
        "write": {"total_uncorrected_errors": 2},
        "verify": {"total_uncorrected_errors": 3},
    }}
    rows = _judged(data, DriveType.SAS, uncorrected="crit")
    row = next(r for r in rows if r.key == "uncorrected_errors")
    assert row.value == "6"
    assert row.detail == "Read 1 · Write 2 · Verify 3"
    assert row.status == "crit"


def test_scsi_lifetime_cycle_row_computes_ratio():
    data = {"scsi_start_stop_cycle_counter": {
        "accumulated_load_unload_cycles": 8000,
        "specified_load_unload_count_over_device_lifetime": 10000,
    }}
    rows = _judged(data, DriveType.SAS)
    row = next(r for r in rows if r.key == "load_unload_cycles")
    assert row.value == "8,000 / 10,000"
    assert row.status == "warn"  # 0.8 ratio hits warn_gte=0.8
    assert row.detail == "80% of rated lifetime"


def test_scsi_lifetime_cycle_row_without_spec_is_ok():
    data = {"scsi_start_stop_cycle_counter": {"accumulated_start_stop_cycles": 500}}
    rows = _judged(data, DriveType.SAS)
    row = next(r for r in rows if r.key == "start_stop_cycles")
    assert row.value == "500"
    assert row.status == "ok"


def test_nvme_critical_warning_row():
    data = {"nvme_smart_health_information_log": {"critical_warning": 1}}
    rows = _judged(data, DriveType.NVME)
    row = next(r for r in rows if r.key == "critical_warning")
    assert row.value == "0x01"
    assert row.status == "crit"


def test_nvme_temperature_converts_kelvin_to_celsius():
    data = {"nvme_smart_health_information_log": {"temperature": 313}}
    rows = _judged(data, DriveType.NVME, temp="ok")
    row = next(r for r in rows if r.key == "temperature")
    assert row.value == "40°C"


def test_nvme_available_spare_below_threshold_warns():
    data = {"nvme_smart_health_information_log": {"available_spare": 5, "available_spare_threshold": 10}}
    rows = _judged(data, DriveType.NVME)
    row = next(r for r in rows if r.key == "available_spare")
    assert row.status == "warn"
    assert row.detail == "Threshold 10%"


def test_nvme_percentage_used_thresholds():
    data = {"nvme_smart_health_information_log": {"percentage_used": 100}}
    rows = _judged(data, DriveType.NVME)
    row = next(r for r in rows if r.key == "percentage_used")
    assert row.status == "crit"


def test_ata_mapped_row_still_fails_on_the_drive_s_own_verdict():
    # The signal flag no longer hides the drive reporting the attribute failed.
    data = {"ata_smart_attributes": {"table": [
        {"id": 5, "name": "Reallocated_Sector_Ct", "raw": {"string": "0", "value": 0},
         "value": 100, "worst": 100, "thresh": 10, "when_failed": "now"},
    ]}}
    assert _judged(data, DriveType.HDD, reallocated="ok")[0].status == "crit"


def test_power_on_hours_rows_take_the_signal_flag_like_the_drive_card():
    ata = {"ata_smart_attributes": {"table": [
        {"id": 9, "name": "Power_On_Hours", "raw": {"string": "51327", "value": 51327},
         "value": 42, "worst": 42, "thresh": 0},
    ]}}
    assert _judged(ata, DriveType.HDD, power_on_hours="warn")[0].status == "warn"
    sas = {"power_on_time": {"hours": 51327}}
    row = next(r for r in _judged(sas, DriveType.SAS, power_on_hours="warn") if r.key == "power_on_hours")
    assert row.status == "warn"
    nvme = {"nvme_smart_health_information_log": {"power_on_hours": 61000}}
    row = next(r for r in _judged(nvme, DriveType.NVME, power_on_hours="crit") if r.key == "power_on_hours")
    assert row.status == "crit"


def test_parsed_rows_carry_facts_not_statuses():
    data = {"scsi_start_stop_cycle_counter": {
        "accumulated_load_unload_cycles": 8000,
        "specified_load_unload_count_over_device_lifetime": 10000,
    }}
    fact = next(asdict(f) for f in parse_attributes(data, DriveType.SAS) if f.key == "load_unload_cycles")
    assert "status" not in fact
    assert fact["signal"] == "load_unload_cycles"
    assert fact["metric"] == {"kind": "rated_lifetime", "measured": 8000, "drive_threshold": 10000}
