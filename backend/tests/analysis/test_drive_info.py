import json
from pathlib import Path

from analysis.drive_info import build_drive_info

_DIR = Path(__file__).parent / "fixtures"
_INFO = json.loads((_DIR / "smartctl_info.json").read_text())
_FULL = json.loads((_DIR / "smartctl_full_reads_x.json").read_text())

_CONNECTION = {
    "scsi_address": "1:0:3:0", "scsi_host": "host1", "scsi_host_driver": "megaraid_sas",
    "pci_address": "0000:00:10.0", "pci_driver": "megaraid_sas",
    "pci_name": "Broadcom / LSI MegaRAID SAS 2008 [Falcon]",
    "pci_subsystem": "Dell PERC H310 Mini Monolithics",
    "pci_link_speed": "5.0 GT/s PCIe", "pci_link_width": "8",
    "pci_max_link_speed": "5.0 GT/s PCIe", "pci_max_link_width": "8",
}


def _build(kind, *, info=True, full=True, connection=None, descriptors=None):
    return build_drive_info(
        info=_INFO[kind] if info else None, info_at="2026-11-25T10:00:00+00:00",
        full=_FULL[kind] if full else None, full_at="2026-11-25T06:00:00+00:00",
        connection=_CONNECTION if connection is None else connection,
        connection_at="2026-11-25T12:00:00+00:00",
        manufacturer="Seagate", white_label=None, block_device="/dev/sde",
        descriptors=descriptors or [("/dev/bus/1", "sat+megaraid,3"), ("/dev/sde", "sat")],
    )


def _rows(result):
    return {r["key"]: r for g in result["groups"] for r in g["rows"]}


def _group(result, gid):
    return next(g for g in result["groups"] if g["id"] == gid)


def test_sata_drive_identity_media_and_link():
    rows = _rows(_build("exos_x16"))
    assert rows["model_number"]["value"] == "ST14000NM001G-2KJ103"
    assert rows["model_family"]["value"] == "Seagate Exos X16"
    assert rows["firmware"]["value"] == "SN03"
    assert rows["capacity"] == {"key": "capacity", "label": "Capacity", "value": 14000519643136, "format": "bytes"}
    assert rows["sectors"]["value"] == 27344764928
    assert rows["logical_sector"]["value"] == 512
    assert rows["physical_sector"]["value"] == 4096
    assert rows["rotation"]["value"] == "7,200 rpm"
    assert rows["interface"]["value"] == "SATA 3.3"
    assert rows["link_rate"]["value"] == "6.0 Gb/s"
    assert rows["standard"]["value"].startswith("ACS-4")
    # ATA drives don't report a manufacture date; HDDs don't show TRIM.
    assert "manufactured" not in rows
    assert "trim" not in rows


def test_ata_wwn_joined_into_one_number():
    wwn = _INFO["exos_x16"]["wwn"]
    expected = f"0x{(wwn['naa'] << 60) | (wwn['oui'] << 36) | wwn['id']:016x}"
    assert _rows(_build("exos_x16"))["wwn"]["value"] == expected


def test_sas_drive_manufacture_date_and_ports_from_full_read():
    result = _build("netapp_x316_sas", descriptors=[("/dev/bus/1", "megaraid,0"), ("/dev/sdb", "scsi")])
    rows = _rows(result)
    assert rows["vendor_id"]["value"] == "NETAPP"
    assert rows["model_number"]["value"] == "X316_SMBPE06TA07"
    assert rows["firmware"]["value"] == "NA00"
    assert rows["wwn"]["value"] == _INFO["netapp_x316_sas"]["logical_unit_id"]
    assert rows["interface"]["value"] == "SAS (SPL-4)"
    assert rows["standard"]["value"] == "SPC-4"
    # Only the full read has these, so they carry its time.
    assert rows["manufactured"] == {"key": "manufactured", "label": "Manufactured", "value": "Week 29, 2017",
                                    "format": "text", "as_of": "2026-11-25T06:00:00+00:00"}
    assert rows["link_rate"]["value"] == "Port 1: 6 Gbps · Port 2: not connected"
    assert rows["controller_phy"]["value"] == "5"
    assert rows["megaraid_device"]["value"] == "0"


def test_sas_physical_sector_defaults_to_logical_when_not_reported():
    assert "physical_block_size" not in _INFO["hgst_hus726060_sas"]
    rows = _rows(_build("hgst_hus726060_sas"))
    assert rows["physical_sector"]["value"] == 512


def test_connection_group_names_the_card_then_the_chip():
    result = _build("exos_x16")
    connection = _group(result, "connection")
    assert connection["as_of"] == "2026-11-25T12:00:00+00:00"
    rows = _rows(result)
    assert rows["controller"]["value"] == "Dell PERC H310 Mini Monolithics"
    assert rows["controller_chip"]["value"] == "Broadcom / LSI MegaRAID SAS 2008 [Falcon]"
    assert rows["controller_link"]["value"] == "5.0 GT/s PCIe x8"
    assert rows["access_paths"]["value"] == "/dev/bus/1 -d sat+megaraid,3, /dev/sde -d sat"
    assert rows["megaraid_device"]["value"] == "3"


def test_controller_without_subsystem_shows_chip_once():
    rows = _rows(_build("exos_x16", connection={"pci_name": "Intel AHCI", "ata_port": "ata3"}))
    assert rows["controller"]["value"] == "Intel AHCI"
    assert "controller_chip" not in rows
    assert rows["ata_port"]["value"] == "ata3"


def test_link_below_max_says_so():
    connection = {**_CONNECTION, "pci_link_speed": "2.5 GT/s PCIe", "pci_link_width": "4"}
    rows = _rows(_build("exos_x16", connection=connection))
    assert rows["controller_link"]["value"] == "2.5 GT/s PCIe x4 (max 5.0 GT/s PCIe x8)"


def test_falls_back_to_full_read_without_info():
    result = _build("exos_x16", info=False)
    assert _group(result, "identity")["as_of"] == "2026-11-25T06:00:00+00:00"
    assert _rows(result)["model_number"]["value"] == "ST14000NM001G-2KJ103"


def test_rows_drive_does_not_report_are_left_out():
    result = _build("hp_mb3000gcvbt", full=False, connection={})
    rows = _rows(result)
    assert "model_family" not in rows        # not in smartctl's drive database
    assert "manufactured" not in rows
    assert not any(r["value"] in (None, "") for r in rows.values())
    # The connection group still has the block device and paths.
    assert {r["key"] for r in _group(result, "connection")["rows"]} == {"block_device", "access_paths", "megaraid_device"}
