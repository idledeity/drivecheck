import copy
import json
from pathlib import Path

import pytest

from analysis.smart_detail import build_smart_detail

_FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "smartctl_full_reads.json").read_text())


@pytest.fixture
def read():
    """A deep copy of one real stored smartctl read, by fixture name."""
    return lambda name: copy.deepcopy(_FIXTURES[name])


def _fields(detail) -> dict:
    return {f["key"]: f for g in detail["groups"] for f in g["fields"]}


def _groups(detail) -> list[str]:
    return [g["key"] for g in detail["groups"]]


# ── ATA ──────────────────────────────────────────────────────────────────────

def test_ata_lists_every_attribute_with_all_columns(read):
    data = read("exos_x16")
    detail = build_smart_detail(data)
    assert len(detail["attributes"]) == len(data["ata_smart_attributes"]["table"])
    raw_read = detail["attributes"][0]
    assert raw_read == {
        "id": 1, "name": "Raw_Read_Error_Rate", "value": 72, "worst": 64, "thresh": 44, "margin": 28,
        "type": "Pre-fail", "updated": "Always", "flags": "POSR--",
        "raw_value": 15231501, "raw_string": "15231501", "when_failed": None, "status": "ok",
    }


def test_ata_attribute_without_a_threshold_has_no_margin(read):
    poh = next(a for a in build_smart_detail(read("exos_x16"))["attributes"] if a["id"] == 9)
    assert poh["thresh"] == 0 and poh["margin"] is None
    assert poh["type"] == "Old-age"


def test_ata_named_fields_from_real_exos(read):
    fields = _fields(build_smart_detail(read("exos_x16")))
    assert (fields["power_on_hours"]["value"], fields["power_on_hours"]["source"]) == (20652, "ATA 9")
    assert fields["load_cycle_count"]["value"] == 3718
    assert fields["load_cycle_count"]["attribute_id"] == 193
    assert fields["head_flying_hours"]["value"] == 660          # from "660h+09m+33.080s"
    assert fields["min_max_190"]["value"] == "27 / 32"          # from "29 (Min/Max 27/32)"
    assert fields["temperature"]["value"] == 29
    assert fields["total_written"]["value"] == 221098461 * 512
    assert fields["self_test_extended_minutes"]["value"] == 1286
    assert fields["error_log_count"]["value"] == 0
    assert all(f["status"] == "ok" for f in fields.values())


def test_ata_groups_in_display_order(read):
    assert _groups(build_smart_detail(read("exos_x16"))) == [
        "status", "lifetime", "media", "interface", "temperature", "data", "capabilities"]


def test_ata_vendor_specific_attributes_are_only_in_the_table(read):
    detail = build_smart_detail(read("hp_mb3000gcvbt"))
    named_ids = {f["attribute_id"] for g in detail["groups"] for f in g["fields"]}
    assert 180 not in named_ids                                  # Unknown_HDD_Attribute
    assert any(a["id"] == 180 for a in detail["attributes"])


def test_ata_lba_counters_only_converted_when_smartctl_names_them_lbas(read):
    data = read("exos_x16")
    for entry in data["ata_smart_attributes"]["table"]:
        if entry["id"] == 241:
            entry["name"] = "Host_Writes_32MiB"
    fields = _fields(build_smart_detail(data))
    assert "total_written" not in fields
    assert "total_read" in fields


def test_ata_named_field_judged_by_its_own_value_against_signal_thresholds(read):
    data = read("exos_x16")
    for entry in data["ata_smart_attributes"]["table"]:
        if entry["id"] == 5:
            entry["raw"] = {"value": 8, "string": "8"}
    detail = build_smart_detail(data)
    assert _fields(detail)["reallocated_sectors"]["status"] == "warn"
    assert next(a for a in detail["attributes"] if a["id"] == 5)["status"] == "warn"


def test_ata_attribute_at_or_below_its_threshold_is_crit(read):
    data = read("exos_x16")
    for entry in data["ata_smart_attributes"]["table"]:
        if entry["id"] == 1:
            entry["value"] = 44
    assert next(a for a in build_smart_detail(data)["attributes"] if a["id"] == 1)["status"] == "crit"


def test_ata_when_failed_is_crit(read):
    data = read("exos_x16")
    for entry in data["ata_smart_attributes"]["table"]:
        if entry["id"] == 7:
            entry["when_failed"] = "in_the_past"
    attr = next(a for a in build_smart_detail(data)["attributes"] if a["id"] == 7)
    assert (attr["status"], attr["when_failed"]) == ("crit", "in_the_past")


def test_failed_smart_status_and_self_test_are_crit(read):
    data = read("exos_x16")
    data["smart_status"]["passed"] = False
    data["ata_smart_data"]["self_test"]["status"] = {"value": 121, "string": "completed: read failure", "passed": False}
    fields = _fields(build_smart_detail(data))
    assert (fields["smart_status"]["value"], fields["smart_status"]["status"]) == ("FAILED", "crit")
    assert fields["self_test_status"]["status"] == "crit"


def test_ata_other_fields_hold_everything_not_shown_elsewhere(read):
    paths = {o["path"] for o in build_smart_detail(read("exos_x16"))["other_fields"]}
    assert "model_family" in paths
    assert "interface_speed.current.string" in paths
    assert "ata_smart_selective_self_test_log.table[0].status.string" in paths
    # Shown elsewhere on the page, or smartctl's own bookkeeping.
    assert not any(p.startswith(("ata_smart_attributes", "ata_smart_self_test_log", "smartctl",
                                 "json_format_version", "local_time", "device.")) for p in paths)


# ── SCSI / SAS ───────────────────────────────────────────────────────────────

def test_sas_real_hgst_with_defects_and_uncorrected_reads(read):
    fields = _fields(build_smart_detail(read("hgst_hus726060_sas")))
    assert (fields["grown_defects"]["value"], fields["grown_defects"]["status"]) == (5, "warn")
    assert (fields["uncorrected_errors"]["value"], fields["uncorrected_errors"]["status"]) == (7, "crit")
    assert fields["power_on_hours"]["status"] == "warn"           # 53,644 h ≥ 40,000
    assert fields["temperature"]["limit"] == {"value": 85, "kind": "trip"}
    assert fields["manufactured"]["value"] == "2015 week 22"
    assert fields["total_read"]["value"] == 333_494_563_000_000


def test_sas_cycles_against_rated_lifetime(read):
    data = read("netapp_x316_sas")
    fields = _fields(build_smart_detail(data))
    assert fields["load_unload_cycles"]["limit"] == {"value": 300000, "kind": "rated"}
    assert fields["load_unload_cycles"]["status"] == "ok"
    data["scsi_start_stop_cycle_counter"]["accumulated_load_unload_cycles"] = 250_000
    assert _fields(build_smart_detail(data))["load_unload_cycles"]["status"] == "warn"   # ≥ 80% of rated


def test_sas_error_counter_grid(read):
    grid = build_smart_detail(read("netapp_x316_sas"))["scsi_error_counters"]
    assert [r["direction"] for r in grid["rows"]] == ["read", "write", "verify"]
    assert grid["rows"][0]["errors_corrected_by_eccfast"] == 2748721516
    assert grid["rows"][0]["gigabytes_processed"] == 2526525.336    # decimal string → number
    assert [c["key"] for c in grid["columns"]][-1] == "total_uncorrected_errors"


def test_sas_other_fields_exclude_the_counter_log_and_self_tests(read):
    paths = {o["path"] for o in build_smart_detail(read("netapp_x316_sas"))["other_fields"]}
    assert "scsi_transport_protocol.name" in paths
    assert not any(p.startswith(("scsi_error_counter_log", "scsi_self_test_")) for p in paths)


# ── NVMe (synthetic: no NVMe drive to capture from yet) ──────────────────────

def _nvme(**log):
    return {"device": {"protocol": "NVMe"}, "smart_status": {"passed": True},
            "nvme_smart_health_information_log": log}


def test_nvme_named_fields_and_full_log():
    detail = build_smart_detail(_nvme(critical_warning=0, temperature=310, available_spare=5,
                                      available_spare_threshold=10, percentage_used=85,
                                      data_units_written=1000, media_errors=0))
    fields = _fields(detail)
    assert fields["temperature"]["value"] == 37
    assert fields["available_spare"]["status"] == "warn"
    assert fields["percentage_used"]["status"] == "warn"
    assert fields["data_units_written"]["value"] == 512_000_000
    assert {"path": "percentage_used", "value": 85} in detail["nvme_health_log"]


def test_nvme_critical_warning_is_crit():
    assert _fields(build_smart_detail(_nvme(critical_warning=4)))["critical_warning"]["status"] == "crit"


# ── no usable data ───────────────────────────────────────────────────────────

def test_unknown_protocol_has_no_groups_but_keeps_other_fields():
    detail = build_smart_detail({"device": {"protocol": "Weird"}, "smartctl": {}, "rotation_rate": 0})
    assert detail["groups"] == []
    assert detail["other_fields"] == [{"path": "rotation_rate", "value": 0}]


# ── full read as smartctl -x -a ──────────────────────────────────────────────

_FULL_X = json.loads((Path(__file__).parent / "fixtures" / "smartctl_full_reads_x.json").read_text())


@pytest.fixture
def read_x():
    """A deep copy of one real smartctl -x -a read, by fixture name."""
    return lambda name: copy.deepcopy(_FULL_X[name])


def _table(detail, key) -> dict:
    return next(t for t in detail["tables"] if t["key"] == key)


@pytest.mark.parametrize("drive", ["exos_x16", "hp_mb3000gcvbt", "netapp_x316_sas", "hgst_hus726060_sas"])
def test_x_keeps_everything_a_reported(read, read_x, drive):
    # -x on ATA swaps in the extended logs; -a keeps the standard ones alongside.
    assert set(read(drive)) <= set(read_x(drive))
    if drive in ("exos_x16", "hp_mb3000gcvbt"):
        assert "standard" in read_x(drive)["ata_smart_self_test_log"]


@pytest.mark.parametrize("drive", ["exos_x16", "hp_mb3000gcvbt"])
def test_x_self_test_log_still_parses(read_x, drive):
    from drives.collector.probes.telemetry.smartctl_self_test_log import parse_self_test_log
    from drives.drive_models import DriveType
    data = read_x(drive)
    standard = data["ata_smart_self_test_log"]["standard"]
    assert len(parse_self_test_log(data, DriveType.HDD)) == len(standard.get("table", [])) == standard["count"]


def test_ata_x_temperature_extremes(read_x):
    fields = _fields(build_smart_detail(read_x("exos_x16")))
    assert fields["temp_lifetime"]["value"] == "22 / 35"
    assert fields["temp_power_cycle"]["value"] == "27 / 34"
    assert fields["temp_op_limits"]["value"] == "5 / 60"
    assert (fields["temp_over_limit"]["value"], fields["temp_over_limit"]["status"]) == (0, "ok")


def test_ata_x_time_above_the_limit_is_warn(read_x):
    data = read_x("exos_x16")
    data["temperature"]["lifetime_over_limit_minutes"] = 12
    assert _fields(build_smart_detail(data))["temp_over_limit"]["status"] == "warn"


def test_ata_x_phy_event_counters(read_x):
    detail = build_smart_detail(read_x("exos_x16"))
    icrc = _fields(detail)["phy_icrc_errors"]
    assert (icrc["value"], icrc["status"]) == (0, "ok")
    assert "phy_icrc_errors" in [f["key"] for g in detail["groups"] if g["key"] == "interface" for f in g["fields"]]
    table = _table(detail, "sata_phy_event_counters")
    assert [c["key"] for c in table["columns"]] == ["id", "name", "value", "overflow"]
    comreset = next(r for r in table["rows"] if r["cells"]["id"] == 10)
    assert comreset["cells"]["value"] == 2


def test_ata_x_icrc_errors_judged_like_crc_errors(read_x):
    data = read_x("exos_x16")
    next(c for c in data["sata_phy_event_counters"]["table"] if c["id"] == 1)["value"] = 3
    assert _fields(build_smart_detail(data))["phy_icrc_errors"]["status"] == "warn"


def test_ata_x_device_statistics_by_page(read_x):
    data = read_x("exos_x16")
    table = _table(build_smart_detail(data), "ata_device_statistics")
    assert len(table["rows"]) == sum(len(p["table"]) for p in data["ata_device_statistics"]["pages"])
    poh = next(r for r in table["rows"] if r["cells"]["name"] == "Power-on Hours")
    assert poh["cells"] == {"page": "General Statistics", "name": "Power-on Hours", "value": 20654, "flags": "V---"}
    assert all(r["status"] == "ok" for r in table["rows"])


def test_ata_x_device_statistic_past_its_own_threshold_is_warn(read_x):
    data = read_x("exos_x16")
    entry = data["ata_device_statistics"]["pages"][0]["table"][0]
    entry["flags"]["monitored_condition_met"] = True
    assert _table(build_smart_detail(data), "ata_device_statistics")["rows"][0]["status"] == "warn"


def test_ata_x_bulky_lists_are_raw_sections_not_other_fields(read_x):
    detail = build_smart_detail(read_x("hp_mb3000gcvbt"))
    assert [r["key"] for r in detail["raw_sections"]] == ["ata_log_directory", "ata_sct_temperature_history"]
    assert detail["raw_sections"][1]["leaves"][0]["path"].startswith("ata_sct_temperature_history.")
    other = {f["path"].split(".")[0].split("[")[0] for f in detail["other_fields"]}
    assert other.isdisjoint({"ata_log_directory", "ata_sct_temperature_history",
                             "ata_device_statistics", "sata_phy_event_counters"})


def test_sas_x_background_scan_errors_not_reassigned(read_x):
    detail = build_smart_detail(read_x("hgst_hus726060_sas"))
    fields = _fields(detail)
    errors = fields["background_scan_errors"]
    assert (errors["value"], errors["status"], errors["detail"]) == (108, "warn", "108 not reassigned")
    assert fields["background_scan"]["value"] == "halted - vendor specific cause"
    table = _table(detail, "scsi_background_scan")
    first = table["rows"][0]
    assert first["cells"] == {"number": 1, "lba": 83866, "power_on_hours": 50834.7, "sense": "Medium Error",
                              "asc_ascq": "0x11/0x00", "reassign": "Require Write or Reassign Blocks command"}
    assert first["status"] == "warn"
    assert table["summarized_by"] == "background_scan_errors"


def test_sas_x_reassigned_scan_results_are_ok(read_x):
    data = read_x("hgst_hus726060_sas")
    for key, result in data["scsi_background_scan"].items():
        if key.startswith("result_"):
            result["reassign_status"] = {"value": 2, "string": "Successfully reassigned"}
    detail = build_smart_detail(data)
    assert _fields(detail)["background_scan_errors"]["status"] == "ok"
    assert all(r["status"] == "ok" for r in _table(detail, "scsi_background_scan")["rows"])


def test_sas_x_idle_background_scan_has_no_results_table(read_x):
    detail = build_smart_detail(read_x("netapp_x316_sas"))
    fields = _fields(detail)
    assert (fields["background_scan_errors"]["value"], fields["background_scan_errors"]["status"]) == (0, "ok")
    assert [t["key"] for t in detail["tables"]] == ["sas_phy_counters"]


def test_sas_x_phy_counters_per_port(read_x):
    table = _table(build_smart_detail(read_x("hgst_hus726060_sas")), "sas_phy_counters")
    assert [(r["cells"]["port"], r["cells"]["phy"]) for r in table["rows"]] == [(0, 0), (1, 1)]
    assert table["rows"][0]["cells"]["invalid_dwords"] == 25
    other = {f["path"].split(".")[0] for f in build_smart_detail(read_x("hgst_hus726060_sas"))["other_fields"]}
    assert not any(k.startswith(("scsi_sas_port_", "scsi_background_scan")) for k in other)


def test_reads_without_x_have_no_tables_or_raw_sections(read):
    detail = build_smart_detail(read("exos_x16"))
    assert (detail["tables"], detail["raw_sections"]) == ([], [])
