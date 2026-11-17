"""
probes.telemetry.smartctl_telemetry — telemetry probe backed by smartctl.

run() is the full read (smartctl -x -a); run_attributes() the collector's
lighter attribute read (smartctl -A -H plus a few logs) between full ones. Both return a
populated DriveTelemetry. Handles ATA, SCSI/SAS, and NVMe signal extraction.
The DCSignals mapping is documented in drives.drive_models.DCSignals.
"""

import logging
from dataclasses import asdict
from datetime import datetime

from drives.collector.probes.telemetry.smartctl_attributes import parse_attributes
from drives.collector.probes.telemetry.smartctl_self_test_log import parse_self_test_log
from drives.tools import smartctl
from drives.drive_models import DCSignals, DriveContext, DriveSnapshot, DriveTelemetry, DriveType, ProbeRecord

logger = logging.getLogger(__name__)

_PROBE_NAME = "drivecheck.probes.telemetry.smartctl_telemetry"


def run(snapshot: DriveSnapshot, context: DriveContext) -> DriveSnapshot:
    """Full read (smartctl -x -a): signals, attribute rows, the self-test log
    and the raw report. What a saved snapshot is made from."""
    descriptor = context.descriptor
    data = smartctl.full_read(descriptor.device_name, descriptor.access_type)
    return _fill(snapshot, context, data, full=True)


# The logs the attribute read adds, by drive type, for the signals they give.
# SAS: error counter log (uncorrected, data processed), background scan
# (pending), phy counters (link errors). ATA: device statistics (data
# processed where 241/242 aren't LBA counts), SATA PHY counters (link errors).
_ATTRIBUTE_READ_LOGS = {
    DriveType.SAS:  ("error", "background", "sasphy"),
    DriveType.NVME: (),
}
_ATA_ATTRIBUTE_READ_LOGS = ("devstat", "sataphy")


def run_attributes(snapshot: DriveSnapshot, context: DriveContext) -> DriveSnapshot:
    """Attribute read (smartctl -A -H, plus the logs some signals come from):
    signals and attribute rows only, for the collector's frequent reads
    between full ones. The self-test log and raw report are left out of
    extras, so the last full read's stay in place. It only runs while the
    drive is busy (heads loaded), so the extra logs cost no head cycles."""
    descriptor = context.descriptor
    logs = _ATTRIBUTE_READ_LOGS.get(context.traits.drive_type, _ATA_ATTRIBUTE_READ_LOGS)
    data = smartctl.attributes_and_health(descriptor.device_name, descriptor.access_type, logs=logs)
    return _fill(snapshot, context, data, full=False)


def _fill(snapshot: DriveSnapshot, context: DriveContext, data: dict, full: bool) -> DriveSnapshot:
    descriptor = context.descriptor
    drive_type = context.traits.drive_type
    if drive_type == DriveType.NVME:
        signals = _map_nvme(data)
    elif drive_type == DriveType.SAS:
        signals = _map_scsi(data)
    else:
        signals = _map_ata(data, context.traits.logical_block_size)

    snapshot.telemetry = DriveTelemetry(signals=signals, last_polled_at=datetime.now())
    # Facts only: health is scored by the collector after the whole chain, and
    # these rows are judged when served (analysis.smart_attributes).
    snapshot.extras["smart_attributes"] = [asdict(r) for r in parse_attributes(data, drive_type)]
    if full:
        snapshot.extras["self_test_log"] = [asdict(r) for r in parse_self_test_log(data, drive_type)]
        snapshot.extras["smartctl"] = data

    errors = [m.get("string", "") for m in data.get("smartctl", {}).get("messages", [])]
    snapshot.probe_log.append(ProbeRecord(probe=_PROBE_NAME, success=not errors, errors=errors))

    if errors:
        logger.warning("telemetry poll for %s reported errors: %s", descriptor.info_name, errors)
    else:
        logger.debug("telemetry poll for %s: signals=%s", descriptor.info_name, signals)

    return snapshot


# SATA PHY event counter IDs that count link errors: 1 is a command failed by
# an interface CRC error; 3-6 are R_ERR responses (a FIS received in error).
_SATA_PHY_ERROR_IDS = {1, 3, 4, 5, 6}

# Attribute ID -> (name the count means LBAs under, signal). Other names for
# 241/242 (e.g. Host_Writes_32MiB) count in other units and aren't used.
_ATA_LBA_COUNTERS = {0xF1: ("Total_LBAs_Written", "data_written"), 0xF2: ("Total_LBAs_Read", "data_read")}
_DEVSTAT_SECTORS = {"Logical Sectors Written": "data_written", "Logical Sectors Read": "data_read"}


def _map_ata(data: dict, logical_block_size: int | None = None) -> DCSignals:
    """Map ATA SMART attribute table (and, when the read has them, the PHY
    event counters and device statistics) to DCSignals. logical_block_size
    (the drive's, from its traits) sizes LBA counts when the read lacks it."""
    table = data.get("ata_smart_attributes", {}).get("table", [])
    attrs = {entry["id"]: entry["raw"]["value"] for entry in table if "raw" in entry}
    names = {entry["id"]: entry.get("name") for entry in table}

    phy = data.get("sata_phy_event_counters", {}).get("table")
    link_errors = sum(c.get("value") or 0 for c in phy if c.get("id") in _SATA_PHY_ERROR_IDS) if phy else None

    block = data.get("logical_block_size") or logical_block_size
    data_bytes = {}
    if block:
        stats = {e.get("name"): e.get("value")
                 for page in data.get("ata_device_statistics", {}).get("pages", [])
                 for e in page.get("table", []) if e.get("flags", {}).get("valid", True)}
        for stat, signal in _DEVSTAT_SECTORS.items():
            if stats.get(stat) is not None:
                data_bytes[signal] = stats[stat] * block
        # The attribute, when the drive names it as an LBA count, wins: it's
        # what the SMART page shows, and every read has it.
        for attr_id, (name, signal) in _ATA_LBA_COUNTERS.items():
            if names.get(attr_id) == name and attrs.get(attr_id) is not None:
                data_bytes[signal] = attrs[attr_id] * block

    # temperature.current is normalized by smartctl across all drives; raw
    # attribute values for IDs 190/194 are drive-family-specific packed fields
    # that may encode min/max history alongside current temp (e.g. Seagate Exos).
    temp = data.get("temperature", {}).get("current") or attrs.get(0xBE) or attrs.get(0xC2)

    return DCSignals(
        power_on_hours=attrs.get(0x09),
        temp=temp,
        reallocated=attrs.get(0x05),
        pending=attrs.get(0xC5),
        uncorrected=attrs.get(0xC6),
        crc_errors=attrs.get(0xC7),
        reallocated_events=attrs.get(0xC4),
        # 193 Load_Cycle_Count: heads parked onto / loaded off the ramp. A
        # plain count on the drives seen (Seagate Exos, HP/WD). Not 192
        # (Power-Off_Retract_Count), which counts emergency retracts only.
        load_unload_cycles=attrs.get(0xC1),
        smart_passed=data.get("smart_status", {}).get("passed"),
        link_errors=link_errors,
        data_written=data_bytes.get("data_written"),
        data_read=data_bytes.get("data_read"),
    )


# Background scan results' reassign_status for a medium error not yet
# reassigned (needs a write or REASSIGN BLOCKS): SAS's pending sector.
_SCAN_UNREASSIGNED = 1

# Per-phy SAS counters of link errors.
_SAS_PHY_ERROR_COUNTS = ("invalid_dword_count", "running_disparity_error_count",
                         "loss_of_dword_synchronization_count", "phy_reset_problem_count")


def _map_scsi(data: dict) -> DCSignals:
    """Map SCSI/SAS error counters and log pages to DCSignals."""
    error_log = data.get("scsi_error_counter_log", {})
    read_errors = error_log.get("read", {}).get("total_uncorrected_errors")
    write_errors = error_log.get("write", {}).get("total_uncorrected_errors")
    uncorrected = None
    if read_errors is not None or write_errors is not None:
        uncorrected = (read_errors or 0) + (write_errors or 0)

    cycle_counter = data.get("scsi_start_stop_cycle_counter", {})

    scan = data.get("scsi_background_scan")
    pending = None
    if scan is not None:
        pending = sum(1 for k, r in scan.items()
                      if k.startswith("result_") and r.get("reassign_status", {}).get("value") == _SCAN_UNREASSIGNED)

    phys = [phy for key, port in data.items() if key.startswith("scsi_sas_port_")
            for name, phy in port.items() if name.startswith("phy_")]
    link_errors = sum(phy.get(c) or 0 for phy in phys for c in _SAS_PHY_ERROR_COUNTS) if phys else None

    def gb_bytes(direction):
        gb = error_log.get(direction, {}).get("gigabytes_processed")
        try:
            return round(float(gb) * 1e9) if gb is not None else None
        except (TypeError, ValueError):
            return None

    return DCSignals(
        power_on_hours=data.get("power_on_time", {}).get("hours"),
        temp=data.get("temperature", {}).get("current"),
        reallocated=data.get("scsi_grown_defect_list"),
        pending=pending,
        uncorrected=uncorrected,
        crc_errors=None,
        reallocated_events=None,
        load_unload_cycles=cycle_counter.get("accumulated_load_unload_cycles"),
        smart_passed=data.get("smart_status", {}).get("passed"),
        link_errors=link_errors,
        data_written=gb_bytes("write"),
        data_read=gb_bytes("read"),
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
        data_written=_nvme_bytes(log.get("data_units_written")),
        data_read=_nvme_bytes(log.get("data_units_read")),
    )


def _nvme_bytes(units: int | None) -> int | None:
    """NVMe data units are 1000 × 512 bytes."""
    return units * 512_000 if units is not None else None


if __name__ == "__main__":
    from drives.collector.probes.scan.smartctl_scan import run as scan_drives
    from drives.collector.probes.traits.smartctl_traits import run as fetch_traits
    from analysis.smart_attributes import judge_report
    from drives.drive_models import DriveContext
    import uuid

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        context = DriveContext(guid=str(uuid.uuid4()), descriptor=descriptor, traits=traits)
        print(f"\n{descriptor.info_name}")
        snapshot = run(DriveSnapshot(), context)
        print(f"  polled_at: {snapshot.telemetry.last_polled_at}")
        for key, value in asdict(snapshot.telemetry.signals).items():
            print(f"  {key}: {value}")
        print(f"  extras keys: {list(snapshot.extras.keys())}")
        print(f"  smart_attributes (judged as served):")
        signals = asdict(snapshot.telemetry.signals)
        for row in judge_report({**snapshot.extras, "signals": signals})["smart_attributes"]:
            print(f"    [{row['status']:>4}] {row['label']}: {row['value']}" + (f"  ({row['detail']})" if row["detail"] else ""))
        print(f"  probe_log: {snapshot.probe_log}")
