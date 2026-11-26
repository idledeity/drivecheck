import os
from pathlib import Path

from drives import connection
from drives.connection import connection_facts, parse_lspci_mm

_LSPCI = ('00:10.0 "RAID bus controller" "Broadcom / LSI" "MegaRAID SAS 2008 [Falcon]" -r03 -p00 '
          '"Dell" "PERC H310 Mini Monolithics"\n')


def _sysfs(tmp_path: Path, device_rel: str, pci: str, host: str) -> Path:
    """A minimal sysfs: block/<dev>/device -> devices/..., the host's proc_name
    and the PCI function's driver link and PCIe link files."""
    sysfs = tmp_path / "sys"
    target = sysfs / device_rel
    target.mkdir(parents=True)
    (sysfs / "block" / "sdb").mkdir(parents=True)
    os.symlink(target, sysfs / "block" / "sdb" / "device")
    (sysfs / "class" / "scsi_host" / host).mkdir(parents=True)
    (sysfs / "class" / "scsi_host" / host / "proc_name").write_text("megaraid_sas\n")
    pci_dir = sysfs / "bus" / "pci" / "devices" / pci
    pci_dir.mkdir(parents=True)
    (sysfs / "bus" / "pci" / "drivers" / "megaraid_sas").mkdir(parents=True)
    os.symlink(sysfs / "bus" / "pci" / "drivers" / "megaraid_sas", pci_dir / "driver")
    (pci_dir / "current_link_speed").write_text("5.0 GT/s PCIe\n")
    (pci_dir / "current_link_width").write_text("8\n")
    return sysfs


def test_reads_scsi_address_host_and_controller(tmp_path, monkeypatch):
    monkeypatch.setattr(connection, "_lspci_names", lambda pci: parse_lspci_mm(_LSPCI))
    sysfs = _sysfs(tmp_path, "devices/pci0000:00/0000:00:10.0/host1/target1:0:3/1:0:3:0", "0000:00:10.0", "host1")
    facts = connection_facts("sdb", sysfs)
    assert facts == {
        "device_path": "devices/pci0000:00/0000:00:10.0/host1/target1:0:3/1:0:3:0",
        "scsi_address": "1:0:3:0",
        "scsi_host": "host1",
        "scsi_host_driver": "megaraid_sas",
        "pci_address": "0000:00:10.0",
        "pci_driver": "megaraid_sas",
        "pci_name": "Broadcom / LSI MegaRAID SAS 2008 [Falcon]",
        "pci_subsystem": "Dell PERC H310 Mini Monolithics",
        "pci_link_speed": "5.0 GT/s PCIe",
        "pci_link_width": "8",
    }


def test_ata_port_from_path(tmp_path, monkeypatch):
    monkeypatch.setattr(connection, "_lspci_names", lambda pci: (None, None))
    sysfs = _sysfs(tmp_path, "devices/pci0000:00/0000:00:17.0/ata3/host2/target2:0:0/2:0:0:0", "0000:00:17.0", "host2")
    assert connection_facts("sdb", sysfs)["ata_port"] == "ata3"


def test_unknown_or_missing_block_device(tmp_path):
    assert connection_facts(None) == {}
    assert connection_facts("sdz", tmp_path) == {}


def test_parse_lspci_mm():
    assert parse_lspci_mm(_LSPCI) == ("Broadcom / LSI MegaRAID SAS 2008 [Falcon]", "Dell PERC H310 Mini Monolithics")
    assert parse_lspci_mm('00:01.1 "IDE interface" "Intel Corporation" "82371SB PIIX3 IDE" -p80 "" ""\n') \
        == ("Intel Corporation 82371SB PIIX3 IDE", None)
    assert parse_lspci_mm("") == (None, None)
