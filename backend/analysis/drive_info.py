"""
analysis.drive_info — a drive's physical attributes, for the Info tab and the Report.

Built when served from stored facts, never stored itself:
  - info: the traits probe's raw `smartctl -i -j` output (traits.extras
    "smartctl_info"), as of the last traits read; or, if a custom traits
    probe didn't keep it, the latest full read (which `-x` also covers)
  - full: the latest full read's raw `smartctl -x -a -j` output, for what
    only it has: SAS manufacture date, SAS negotiated link rate and the
    controller phy a SAS drive is attached to
  - connection: drives.connection facts (sysfs, lspci), read now

Rows are grouped by section; each group carries the time its values were
read (as_of), and a row from a different source carries its own.
A value the drive doesn't report is left out, not shown as "—".

Row "format" tells the UI how to show value:
  text   — as is
  bytes  — a capacity in bytes (shown rounded, plus the exact count)
  size   — a small size in bytes (sector sizes)
  count  — an integer, with digit grouping
"""

import re

_MEGARAID_DEVICE = re.compile(r"megaraid,(\d+)")


def build_drive_info(
    *,
    info: dict | None,
    info_at: str | None,
    full: dict | None,
    full_at: str | None,
    connection: dict,
    connection_at: str,
    manufacturer: str | None,
    white_label: str | None,
    block_device: str | None,
    descriptors: list[tuple[str, str]],
) -> dict:
    """{"groups": [{"id", "title", "as_of", "rows": [{"key", "label", "value", "format", "as_of"?}]}]}"""
    if not info and full:
        info, info_at = full, full_at
    info = info or {}
    full = full or {}
    rotation = info.get("rotation_rate")
    is_nvme = (info.get("device", {}).get("protocol") or "").upper() == "NVME"

    identity = [
        _row("manufacturer", "Manufacturer", manufacturer),
        _row("sold_as", "Sold as", f"{white_label} OEM" if white_label else None),
        _row("vendor_id", "Vendor ID", None if _same(info.get("scsi_vendor"), manufacturer)
             else info.get("scsi_vendor")),
        _row("model_number", "Model number", info.get("model_name") or info.get("scsi_product")),
        _row("model_family", "Model family", info.get("model_family")),
        _row("serial", "Serial number", info.get("serial_number")),
        _row("firmware", "Firmware", info.get("firmware_version") or info.get("scsi_revision")),
        _row("wwn", "WWN", _wwn(info)),
        _row("manufactured", "Manufactured", _manufactured(full), as_of=full_at),
    ]

    logical = info.get("logical_block_size")
    # SCSI drives only report a physical block size when it differs from the
    # logical one (smartctl prints it only when the LB-per-PB exponent is > 0).
    physical = info.get("physical_block_size") or (logical if info.get("scsi_product") else None)
    capacity = info.get("user_capacity", {})
    media = [
        _row("capacity", "Capacity", capacity.get("bytes"), "bytes"),
        _row("sectors", "Sectors", capacity.get("blocks"), "count"),
        _row("logical_sector", "Logical sector size", logical, "size"),
        _row("physical_sector", "Physical sector size", physical, "size"),
        _row("form_factor", "Form factor", info.get("form_factor", {}).get("name")),
        _row("rotation", "Rotation",
             f"{rotation:,} rpm" if rotation else "Solid state" if rotation == 0 else None),
        _row("trim", "TRIM", _yes_no(info.get("trim", {}).get("supported")) if rotation == 0 else None),
    ]

    interface = [
        _row("interface", "Interface", _interface(info)),
        _row("standard", "Standard", info.get("ata_version", {}).get("string") or info.get("scsi_version")),
        _row("link_rate", "Link rate", _sata_link(info)),
    ]
    sas_ports = _sas_ports(full)
    if sas_ports:
        interface.append(_row("link_rate", "Link rate",
                              " · ".join(f"Port {i + 1}: {p['rate']}" for i, p in enumerate(sas_ports)),
                              as_of=full_at))
    if is_nvme:
        interface.append(_row("link_rate", "Link rate", _pcie_link(connection), as_of=connection_at))

    megaraid_ids = sorted({m.group(1) for _, access in descriptors if (m := _MEGARAID_DEVICE.search(access))})
    attached_phys = [str(p["phy"]) for p in sas_ports if p["phy"] is not None]
    controller = connection.get("pci_subsystem") or connection.get("pci_name")
    connection_rows = [
        _row("block_device", "Block device", block_device),
        _row("access_paths", "smartctl paths",
             ", ".join(f"{name} -d {access}" for name, access in descriptors) or None),
        _row("controller", "Controller", controller),
        _row("controller_chip", "Controller chip",
             connection.get("pci_name") if connection.get("pci_subsystem") else None),
        _row("controller_driver", "Driver", connection.get("pci_driver")),
        _row("pci_address", "PCI address", connection.get("pci_address")),
        _row("controller_link", "Controller link", None if is_nvme else _pcie_link(connection)),
        _row("scsi_address", "SCSI address", connection.get("scsi_address")),
        _row("ata_port", "ATA port", connection.get("ata_port")),
        _row("megaraid_device", "MegaRAID device ID", ", ".join(megaraid_ids) or None),
        _row("controller_phy", "Controller phy", ", ".join(attached_phys) or None, as_of=full_at),
    ]

    groups = [
        _group("identity", "Identity", info_at, identity),
        _group("media", "Media", info_at, media),
        _group("interface", "Interface", info_at, interface),
        _group("connection", "Connection", connection_at, connection_rows),
    ]
    return {"groups": [g for g in groups if g["rows"]]}


def _row(key: str, label: str, value, fmt: str = "text", as_of: str | None = None) -> dict | None:
    if value is None or value == "":
        return None
    row = {"key": key, "label": label, "value": value, "format": fmt}
    if as_of is not None:
        row["as_of"] = as_of
    return row


def _group(gid: str, title: str, as_of: str | None, rows: list[dict | None]) -> dict:
    kept = [r for r in rows if r is not None]
    # A row whose own time matches the group's needs no separate age.
    for r in kept:
        if r.get("as_of") == as_of:
            r.pop("as_of")
    return {"id": gid, "title": title, "as_of": as_of, "rows": kept}


def _same(a: str | None, b: str | None) -> bool:
    return bool(a) and bool(b) and a.strip().lower() == b.strip().lower()


def _yes_no(value: bool | None) -> str | None:
    return None if value is None else "Supported" if value else "Not supported"


def _wwn(info: dict) -> str | None:
    """The World Wide Name as one 16-digit hex number, as SAS drives report
    their logical unit ID (ATA gives it in parts: NAA, IEEE OUI, vendor id)."""
    if info.get("logical_unit_id"):
        return info["logical_unit_id"]
    wwn = info.get("wwn")
    if not wwn or wwn.get("naa") is None or wwn.get("oui") is None or wwn.get("id") is None:
        return None
    return f"0x{(wwn['naa'] << 60) | (wwn['oui'] << 36) | wwn['id']:016x}"


def _manufactured(full: dict) -> str | None:
    """SAS drives' date of manufacture (start-stop cycle counter page)."""
    page = full.get("scsi_start_stop_cycle_counter", {})
    year, week = page.get("year_of_manufacture"), page.get("week_of_manufacture")
    if not year:
        return None
    return f"Week {int(week)}, {year}" if week else str(year)


def _interface(info: dict) -> str | None:
    sata = info.get("sata_version", {}).get("string")
    if sata:
        return sata
    sas = info.get("scsi_transport_protocol", {}).get("name")
    if sas:
        return sas
    return info.get("device", {}).get("protocol")


def _sata_link(info: dict) -> str | None:
    speed = info.get("interface_speed", {})
    current = speed.get("current", {}).get("string")
    maximum = speed.get("max", {}).get("string")
    if not current:
        return None
    return current if not maximum or maximum == current else f"{current} (max {maximum})"


def _sas_ports(full: dict) -> list[dict]:
    """Each SAS port's negotiated rate and the controller phy at its other
    end, from the full read's protocol-specific port pages; a port with
    nothing attached shows as "not connected"."""
    ports = []
    for key in sorted(k for k in full if k.startswith("scsi_sas_port_")):
        phys = [v for name, v in full[key].items() if name.startswith("phy_") and isinstance(v, dict)]
        if not phys:
            continue
        phy = phys[0]
        attached = phy.get("attached_device_type", "")
        if attached.startswith("no device"):
            ports.append({"rate": "not connected", "phy": None})
            continue
        rate = phy.get("negotiated_logical_link_rate") or ""
        rate = rate.split(";")[-1].strip() or "unknown"
        ports.append({"rate": rate, "phy": phy.get("attached_phy_identifier")})
    return ports


def _pcie_link(connection: dict) -> str | None:
    speed, width = connection.get("pci_link_speed"), connection.get("pci_link_width")
    if not speed:
        return None
    text = f"{speed} x{width}" if width else speed
    max_speed, max_width = connection.get("pci_max_link_speed"), connection.get("pci_max_link_width")
    if (max_speed and max_speed != speed) or (max_width and max_width != width):
        text += f" (max {max_speed or speed} x{max_width or width})"
    return text
