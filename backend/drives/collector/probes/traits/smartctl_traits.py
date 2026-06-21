"""
probes.traits.smartctl_traits — traits probe backed by smartctl -i.

Accepts a DriveDescriptor, queries the drive for static identity fields,
and returns a populated DriveTraits. Stable data — serial, model, capacity,
type, form factor, rpm, bus — that the collector caches in DriveContext and
re-uses across polls rather than re-querying every time.
"""

from drives.tools import smartctl
from drives.drive_models import DriveDescriptor, DriveTraits, DriveType


def run(descriptor: DriveDescriptor) -> DriveTraits:
    """Query a drive's static identity via smartctl -i and return its traits."""
    data = smartctl.info(descriptor.device_name, descriptor.access_type)

    rotation_rate = data.get("rotation_rate")

    return DriveTraits(
        serial=data.get("serial_number"),
        model=data.get("model_name") or data.get("scsi_product"),
        manufacturer=data.get("scsi_vendor"),
        capacity_bytes=data.get("user_capacity", {}).get("bytes"),
        drive_type=_infer_drive_type(data),
        form_factor=data.get("form_factor", {}).get("name"),
        rpm=rotation_rate if rotation_rate and rotation_rate > 0 else None,
        bus=_parse_bus(data),
    )


def _infer_drive_type(data: dict) -> DriveType:
    """Infer DriveType from device type string and rotation_rate."""
    device_type = data.get("device", {}).get("type", "").lower()
    rotation_rate = data.get("rotation_rate")

    if "nvme" in device_type:
        return DriveType.NVME
    if "scsi" in device_type or "sas" in device_type:
        return DriveType.SAS
    # ATA / SAT / unknown — use rotation_rate to distinguish HDD vs SSD
    if rotation_rate is not None:
        return DriveType.HDD if rotation_rate > 0 else DriveType.SSD
    return DriveType.UNKNOWN


def _parse_bus(data: dict) -> str | None:
    """Return a human-readable bus string, e.g. "SATA III · 6.0 Gb/s" or "NVMe"."""
    # SATA: interface_speed.current.string → e.g. "6.0 Gb/s"
    speed_str = (
        data.get("interface_speed", {})
            .get("current", {})
            .get("string")
    )
    if speed_str:
        # Map speed string to SATA generation label
        gen_map = {"1.5 Gb/s": "SATA I", "3.0 Gb/s": "SATA II", "6.0 Gb/s": "SATA III"}
        gen = gen_map.get(speed_str, "SATA")
        return f"{gen} · {speed_str}"

    # SAS: use transport protocol name for an accurate label ("SAS (SPL-4)" etc.)
    sas_transport = data.get("scsi_transport_protocol", {}).get("name")
    if sas_transport:
        return sas_transport

    # NVMe / other: fall back to protocol field
    protocol = data.get("device", {}).get("protocol")
    return protocol or None


if __name__ == "__main__":
    from dataclasses import asdict
    from drives.collector.probes.scan.smartctl_scan import run as scan_drives

    for descriptor in scan_drives():
        print(f"\n{descriptor.info_name}")
        traits = run(descriptor)
        for key, value in asdict(traits).items():
            print(f"  {key}: {value}")
