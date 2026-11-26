"""
drives.connection — how a drive is connected to this machine, read from sysfs.

Facts only, from the kernel's view of the block device: its SCSI address,
the SCSI host and its driver, and the PCI device (the controller, or the
drive itself for NVMe) with its name and PCIe link. No drive I/O — these are
file reads plus one `lspci` per controller, cached — so they're read when
served rather than collected.

Physical bay/slot is not here: on most RAID controllers it needs the
vendor's tool (storcli, ssacli, arcconf), a feature of its own.
"""

import functools
import logging
import re
import shlex
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

SYSFS = Path("/sys")

_PCI_ADDRESS = re.compile(r"^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$")
_HCTL = re.compile(r"^\d+:\d+:\d+:\d+$")
_SCSI_HOST = re.compile(r"^host\d+$")
_ATA_PORT = re.compile(r"^ata\d+$")


def connection_facts(block_device: str | None, sysfs: Path = SYSFS) -> dict:
    """What sysfs says about how `block_device` (e.g. "sdb") is attached.
    {} if it has no block device or sysfs doesn't know it."""
    if not block_device:
        return {}
    try:
        device_path = (sysfs / "block" / block_device / "device").resolve(strict=True)
    except OSError:
        return {}

    parts = device_path.parts
    facts: dict = {"device_path": str(device_path.relative_to(sysfs)) if device_path.is_relative_to(sysfs)
                   else str(device_path)}

    if _HCTL.match(parts[-1]):
        facts["scsi_address"] = parts[-1]
    ata_port = next((p for p in reversed(parts) if _ATA_PORT.match(p)), None)
    if ata_port:
        facts["ata_port"] = ata_port   # libata port (onboard SATA / AHCI), e.g. "ata3"
    host = next((p for p in reversed(parts) if _SCSI_HOST.match(p)), None)
    if host:
        facts["scsi_host"] = host
        facts["scsi_host_driver"] = _read(sysfs / "class" / "scsi_host" / host / "proc_name")

    # The PCI function nearest the drive: the HBA / RAID controller / AHCI
    # controller for SCSI-attached drives, the drive itself for NVMe.
    pci = next((p for p in reversed(parts) if _PCI_ADDRESS.match(p)), None)
    if pci:
        pci_dir = sysfs / "bus" / "pci" / "devices" / pci
        facts["pci_address"] = pci
        facts["pci_driver"] = _link_name(pci_dir / "driver")
        facts["pci_name"], facts["pci_subsystem"] = _lspci_names(pci)
        facts["pci_link_speed"] = _read(pci_dir / "current_link_speed")
        facts["pci_link_width"] = _read(pci_dir / "current_link_width")
        facts["pci_max_link_speed"] = _read(pci_dir / "max_link_speed")
        facts["pci_max_link_width"] = _read(pci_dir / "max_link_width")
    return {k: v for k, v in facts.items() if v not in (None, "")}


def _read(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _link_name(path: Path) -> str | None:
    try:
        return path.resolve(strict=True).name
    except OSError:
        return None


@functools.lru_cache(maxsize=32)
def _lspci_names(pci_address: str) -> tuple[str | None, str | None]:
    """(chip, card) names for a PCI address from `lspci -mm`; (None, None) if
    lspci is missing or doesn't know it."""
    try:
        result = subprocess.run(["lspci", "-mm", "-s", pci_address],
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.debug("lspci failed for %s: %s", pci_address, e)
        return None, None
    return parse_lspci_mm(result.stdout)


def parse_lspci_mm(output: str) -> tuple[str | None, str | None]:
    """From one `lspci -mm` line, "vendor device" (the chip) and "subsystem
    vendor subsystem device" (the card it's on, often the more recognisable
    name), e.g. from
      00:10.0 "RAID bus controller" "Broadcom / LSI" "MegaRAID SAS 2008 [Falcon]" -r03 -p00 "Dell" "PERC H310 Mini Monolithics"
    ("Broadcom / LSI MegaRAID SAS 2008 [Falcon]", "Dell PERC H310 Mini Monolithics").
    Fields: slot, class, vendor, device, then -r/-p options, then the
    subsystem pair (empty strings when it has none)."""
    line = output.strip().splitlines()[0] if output.strip() else ""
    try:
        values = [f for f in shlex.split(line) if not f.startswith("-")]
    except ValueError:
        return None, None
    if len(values) < 4:
        return None, None
    chip = f"{values[2]} {values[3]}".strip() or None
    sub = " ".join(v for v in values[4:6] if v).strip() or None
    return chip, sub
