"""
probes.telemetry.smartctl_telemetry — telemetry probe backed by smartctl -a.

Accepts a DriveContext, queries live SMART data, and returns a populated
DriveTelemetry. Handles ATA, SCSI/SAS, and NVMe signal extraction.
The DCSignals mapping is documented in models.DCSignals.
"""

from dataclasses import asdict
from datetime import datetime

from analysis.health import score_health
from analysis.smart_attributes import build_attribute_rows
from drive_tools import smartctl
from models import DCSignals, DriveContext, DriveSnapshot, DriveTelemetry, DriveType, ProbeRecord

_PROBE_NAME = "drivecheck.probes.telemetry.smartctl_telemetry"


def run(snapshot: DriveSnapshot, context: DriveContext) -> DriveSnapshot:
    """Query live SMART attributes for a drive and enrich the snapshot."""
    descriptor = context.descriptor
    data = smartctl.attributes_all(descriptor.device_name, descriptor.access_type)

    drive_type = context.traits.drive_type
    if drive_type == DriveType.NVME:
        signals = _map_nvme(data)
    elif drive_type == DriveType.SAS:
        signals = _map_scsi(data)
    else:
        signals = _map_ata(data)

    snapshot.telemetry = DriveTelemetry(signals=signals, last_polled_at=datetime.now())
    snapshot.health = score_health(signals)
    rows = build_attribute_rows(data, drive_type, signals, snapshot.health)
    snapshot.extras["smart_attributes"] = [asdict(r) for r in rows]
    snapshot.extras["smartctl"] = data

    errors = [m.get("string", "") for m in data.get("smartctl", {}).get("messages", [])]
    snapshot.probe_log.append(ProbeRecord(probe=_PROBE_NAME, success=not errors, errors=errors))

    return snapshot


def _map_ata(data: dict) -> DCSignals:
    """Map ATA SMART attribute table to DCSignals."""
    attrs = {
        entry["id"]: entry["raw"]["value"]
        for entry in data.get("ata_smart_attributes", {}).get("table", [])
        if "raw" in entry
    }

    temp = attrs.get(0xBE) or attrs.get(0xC2)  # 190 (Airflow Temp) or 194 (HDA Temp)

    return DCSignals(
        power_on_hours=attrs.get(0x09),
        temp=temp,
        reallocated=attrs.get(0x05),
        pending=attrs.get(0xC5),
        uncorrected=attrs.get(0xC6),
        crc_errors=attrs.get(0xC7),
        reallocated_events=attrs.get(0xC4),
        smart_passed=data.get("smart_status", {}).get("passed"),
    )


def _map_scsi(data: dict) -> DCSignals:
    """Map SCSI/SAS error counters and log pages to DCSignals."""
    error_log = data.get("scsi_error_counter_log", {})
    read_errors = error_log.get("read", {}).get("total_uncorrected_errors")
    write_errors = error_log.get("write", {}).get("total_uncorrected_errors")
    uncorrected = None
    if read_errors is not None or write_errors is not None:
        uncorrected = (read_errors or 0) + (write_errors or 0)

    cycle_counter = data.get("scsi_start_stop_cycle_counter", {})

    return DCSignals(
        power_on_hours=data.get("power_on_time", {}).get("hours"),
        temp=data.get("temperature", {}).get("current"),
        reallocated=data.get("scsi_grown_defect_list"),
        pending=None,
        uncorrected=uncorrected,
        crc_errors=None,
        reallocated_events=None,
        load_unload_cycles=cycle_counter.get("accumulated_load_unload_cycles"),
        smart_passed=data.get("smart_status", {}).get("passed"),
    )


def _map_nvme(data: dict) -> DCSignals:
    """Map NVMe health information log to DCSignals."""
    log = data.get("nvme_smart_health_information_log", {})

    temp_kelvin = log.get("temperature")
    temp = (temp_kelvin - 273) if temp_kelvin is not None else None

    return DCSignals(
        power_on_hours=log.get("power_on_hours"),
        temp=temp,
        reallocated=None,
        pending=None,
        uncorrected=log.get("media_errors"),
        crc_errors=None,
        reallocated_events=None,
        smart_passed=data.get("smart_status", {}).get("passed"),
    )


if __name__ == "__main__":
    from probes.scan.smartctl_scan import run as scan_drives
    from probes.traits.smartctl_traits import run as fetch_traits
    from models import DriveContext
    import uuid

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        context = DriveContext(guid=str(uuid.uuid4()), descriptor=descriptor, traits=traits)
        print(f"\n{descriptor.info_name}")
        snapshot = run(DriveSnapshot(), context)
        print(f"  polled_at: {snapshot.telemetry.last_polled_at}")
        for key, value in asdict(snapshot.telemetry.signals).items():
            print(f"  {key}: {value}")
        print(f"  health: {snapshot.health}")
        print(f"  extras keys: {list(snapshot.extras.keys())}")
        print(f"  smart_attributes:")
        for row in snapshot.extras["smart_attributes"]:
            print(f"    [{row['status']:>4}] {row['label']}: {row['value']}" + (f"  ({row['detail']})" if row["detail"] else ""))
        print(f"  probe_log: {snapshot.probe_log}")
