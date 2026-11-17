"""Signal mapping in the smartctl telemetry probe, against real smartctl output."""

import json
from pathlib import Path

import pytest

from drives.drive_models import DriveType

from drives.collector.probes.telemetry.smartctl_telemetry import _map_ata, _map_scsi

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "smartctl_ata_attributes.json").read_text())


@pytest.mark.parametrize("drive, cycles, power_on_hours", [
    ("exos_x16", 3580, 20582),
    ("hp_mb3000gcvbt", 4, 67066),
])
def test_ata_maps_load_cycle_count(drive, cycles, power_on_hours):
    signals = _map_ata(FIXTURES[drive])
    assert signals.load_unload_cycles == cycles     # attr 193, not 192 (power-off retracts)
    assert signals.power_on_hours == power_on_hours
    assert signals.reallocated == 0 and signals.pending == 0 and signals.crc_errors == 0
    assert signals.smart_passed is True


def test_ata_without_attribute_193_reports_none():
    data = json.loads(json.dumps(FIXTURES["exos_x16"]))
    data["ata_smart_attributes"]["table"] = [e for e in data["ata_smart_attributes"]["table"] if e["id"] != 193]
    assert _map_ata(data).load_unload_cycles is None


# ── link errors, data processed, SAS pending (real -x -a and attribute reads) ─

_ANALYSIS_FIXTURES = Path(__file__).parents[2] / "analysis" / "fixtures"
FULL_X = json.loads((_ANALYSIS_FIXTURES / "smartctl_full_reads_x.json").read_text())
ATTR = json.loads((_ANALYSIS_FIXTURES / "smartctl_attribute_reads.json").read_text())
ATTR_EXT = json.loads((_ANALYSIS_FIXTURES / "smartctl_attribute_reads_ext.json").read_text())


def test_ata_data_processed_from_lba_attributes():
    signals = _map_ata(FULL_X["exos_x16"])         # 241/242 named as LBA counts, 512-byte LBAs
    assert signals.data_written == 221098461 * 512
    assert signals.data_read == 138086730372 * 512
    assert signals.link_errors == 0


def test_ata_data_processed_from_device_statistics_without_lba_attributes():
    # The HP has no 241/242; device statistics count logical sectors.
    assert _map_ata(FULL_X["hp_mb3000gcvbt"]).data_written == 439312103736 * 512


def test_ata_attribute_read_sizes_lbas_by_the_drive_s_traits():
    # An attribute read doesn't report the block size; the traits know it.
    ext = ATTR_EXT["hp_mb3000gcvbt"]
    assert "logical_block_size" not in ext
    sectors = next(e["value"] for page in ext["ata_device_statistics"]["pages"] for e in page["table"]
                   if e["name"] == "Logical Sectors Written")
    assert _map_ata(ext, logical_block_size=512).data_written == sectors * 512
    assert _map_ata(ext).data_written is None


def test_ata_plain_attribute_read_lacks_the_log_signals():
    signals = _map_ata(ATTR["hp_mb3000gcvbt"], logical_block_size=512)
    assert (signals.link_errors, signals.data_written) == (None, None)


def test_ata_link_errors_count_icrc_and_r_err_only():
    data = json.loads(json.dumps(FULL_X["hp_mb3000gcvbt"]))
    for counter in data["sata_phy_event_counters"]["table"]:
        counter["value"] = {1: 2, 3: 1, 6: 4, 10: 99}.get(counter["id"], 0)   # 10 = COMRESET, not an error
    assert _map_ata(data).link_errors == 7


def test_sas_pending_is_unreassigned_background_scan_errors():
    assert _map_scsi(FULL_X["hgst_hus726060_sas"]).pending == 108
    assert _map_scsi(ATTR_EXT["hgst_hus726060_sas"]).pending == 108
    assert _map_scsi(FULL_X["netapp_x316_sas"]).pending == 0
    assert _map_scsi(ATTR["hgst_hus726060_sas"]).pending is None    # no background scan in this read


def test_sas_link_errors_sum_every_phy():
    # Port 0: 25 invalid dwords + 24 disparity + 8 loss of sync; port 1 the rest.
    hgst = FULL_X["hgst_hus726060_sas"]
    expected = sum(hgst[p][phy][c] for p in ("scsi_sas_port_0", "scsi_sas_port_1") for phy in hgst[p] if phy.startswith("phy_")
                   for c in ("invalid_dword_count", "running_disparity_error_count",
                             "loss_of_dword_synchronization_count", "phy_reset_problem_count"))
    assert _map_scsi(hgst).link_errors == expected == 57
    assert _map_scsi(ATTR["hgst_hus726060_sas"]).link_errors is None


def test_sas_data_processed_from_the_error_counter_log():
    signals = _map_scsi(FULL_X["hgst_hus726060_sas"])
    assert signals.data_read == 333_494_563_000_000          # "333494.563" GB
    assert signals.data_written == 74_649_922_000_000


def test_nvme_data_processed_in_data_units():
    from drives.collector.probes.telemetry.smartctl_telemetry import _map_nvme
    signals = _map_nvme({"nvme_smart_health_information_log": {"data_units_written": 10, "data_units_read": 3}})
    assert (signals.data_written, signals.data_read) == (5_120_000, 1_536_000)


@pytest.mark.parametrize("drive_type, logs", [
    (DriveType.SAS, ("error", "background", "sasphy")),
    (DriveType.HDD, ("devstat", "sataphy")),
    (DriveType.SSD, ("devstat", "sataphy")),
    (DriveType.NVME, ()),
])
def test_attribute_read_adds_the_logs_its_signals_come_from(monkeypatch, drive_type, logs):
    from drives.collector.probes.telemetry import smartctl_telemetry
    from drives.drive_models import DriveContext, DriveDescriptor, DriveSnapshot, DriveTraits
    calls = []
    monkeypatch.setattr(smartctl_telemetry.smartctl, "attributes_and_health",
                        lambda _d, _a, logs=(): calls.append(logs) or {})
    context = DriveContext(guid="g", descriptor=DriveDescriptor("/dev/sdz", "sat", "/dev/sdz"),
                           traits=DriveTraits(drive_type=drive_type))
    smartctl_telemetry.run_attributes(DriveSnapshot(), context)
    assert calls == [logs]


def test_extended_attribute_read_gives_the_log_signals():
    from drives.collector.probes.telemetry.smartctl_telemetry import _map_ata
    hgst = _map_scsi(ATTR_EXT["hgst_hus726060_sas"])
    assert (hgst.pending, hgst.link_errors) == (108, 57)
    hp = _map_ata(ATTR_EXT["hp_mb3000gcvbt"], logical_block_size=512)
    assert hp.link_errors == 0 and hp.data_written is not None
