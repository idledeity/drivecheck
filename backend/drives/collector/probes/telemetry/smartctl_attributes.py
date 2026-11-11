"""
probes.telemetry.smartctl_attributes — Parse smartctl -a JSON into per-attribute
facts for the Health -> SMART attributes sub-page.

Facts only: each AttributeFact carries what the drive reported, plus — where it
has them — the inputs analysis.smart_attributes judges it by (the DCSignals
field it shows, a metric, the drive's own verdict). No ok/warn/crit is decided
here. A helper for smartctl_telemetry, not a probe itself (no run()).
"""

import logging

from drives.drive_models import AttributeFact, AttributeMetric, DriveType

logger = logging.getLogger(__name__)

# ATA SMART attribute IDs that map onto a DCSignals field (see smartctl_telemetry._map_ata).
_ATA_SIGNAL_IDS = {
    5: "reallocated", 9: "power_on_hours", 190: "temp", 194: "temp",
    197: "pending", 198: "uncorrected", 199: "crc_errors",
}


def parse_attributes(data: dict, drive_type: DriveType) -> list[AttributeFact]:
    """Per-attribute facts for a drive's raw smartctl -a JSON."""
    if drive_type == DriveType.NVME:
        rows = _nvme_rows(data)
    elif drive_type == DriveType.SAS:
        rows = _scsi_rows(data)
    else:
        rows = _ata_rows(data)
    logger.debug("parsed %d attribute row(s) for drive_type=%s", len(rows), drive_type)
    return rows


def _ata_rows(data: dict) -> list[AttributeFact]:
    """Full raw attribute dump from ata_smart_attributes.table — one row per entry."""
    rows = []
    for entry in data.get("ata_smart_attributes", {}).get("table", []):
        attr_id = entry.get("id")
        raw = entry.get("raw", {})
        value, worst, thresh = entry.get("value"), entry.get("worst"), entry.get("thresh")
        rows.append(AttributeFact(
            key=f"ata_{attr_id}",
            label=entry.get("name", f"Attribute {attr_id}").replace("_", " "),
            value=raw.get("string", str(raw.get("value", "—"))),
            detail=f"value {value} · worst {worst} · thresh {thresh}",
            signal=_ATA_SIGNAL_IDS.get(attr_id),
            # The drive's normalized value against its own threshold (0 = none).
            metric=AttributeMetric("normalized_value", value, thresh) if value is not None else None,
            drive_report="failed" if entry.get("when_failed") else None,
        ))
    return rows


def _scsi_rows(data: dict) -> list[AttributeFact]:
    """Curated rows from SCSI/SAS error counters and log pages."""
    rows = []

    smart_status = data.get("smart_status", {})
    passed = smart_status.get("passed")
    rows.append(AttributeFact(
        key="smart_status",
        label="SMART Overall Status",
        value="PASSED" if passed else "FAILED" if passed is False else "—",
        detail=smart_status.get("scsi", {}).get("ie_string") if passed is False else None,
        drive_report="failed" if passed is False else "ok" if passed else None,
    ))

    temp = data.get("temperature", {})
    if temp.get("current") is not None:
        trip = temp.get("drive_trip")
        rows.append(AttributeFact(
            key="temperature",
            label="Temperature",
            value=f"{temp['current']}°C",
            detail=f"Trip threshold {trip}°C" if trip is not None else None,
            signal="temp",
        ))

    poh = data.get("power_on_time", {}).get("hours")
    if poh is not None:
        rows.append(AttributeFact(key="power_on_hours", label="Power-On Hours", value=f"{poh:,}", signal="power_on_hours"))

    defects = data.get("scsi_grown_defect_list")
    if defects is not None:
        rows.append(AttributeFact(key="grown_defect_list", label="Grown Defect List", value=f"{defects:,}", signal="reallocated"))

    error_log = data.get("scsi_error_counter_log")
    if error_log:
        read_u   = error_log.get("read",   {}).get("total_uncorrected_errors") or 0
        write_u  = error_log.get("write",  {}).get("total_uncorrected_errors") or 0
        verify_u = error_log.get("verify", {}).get("total_uncorrected_errors") or 0
        rows.append(AttributeFact(
            key="uncorrected_errors",
            label="Uncorrected Errors",
            value=f"{read_u + write_u + verify_u:,}",
            detail=f"Read {read_u} · Write {write_u} · Verify {verify_u}",
            signal="uncorrected",
        ))

    cycles = data.get("scsi_start_stop_cycle_counter", {})
    rows += _lifetime_cycle_row(
        cycles, "load_unload_cycles", "Load/Unload Cycles",
        "accumulated_load_unload_cycles", "specified_load_unload_count_over_device_lifetime",
        signal="load_unload_cycles",
    )
    rows += _lifetime_cycle_row(
        cycles, "start_stop_cycles", "Start/Stop Cycles",
        "accumulated_start_stop_cycles", "specified_cycle_count_over_device_lifetime",
    )

    return rows


def _lifetime_cycle_row(cycles: dict, key: str, label: str, accumulated_field: str, specified_field: str,
                        signal: str | None = None) -> list[AttributeFact]:
    """A row for an accumulated cycle count, measured against its rated lifetime if the drive reports one."""
    accumulated = cycles.get(accumulated_field)
    if accumulated is None:
        return []

    specified = cycles.get(specified_field)
    if specified:
        return [AttributeFact(
            key=key,
            label=label,
            value=f"{accumulated:,} / {specified:,}",
            detail=f"{accumulated / specified * 100:.0f}% of rated lifetime",
            signal=signal,
            metric=AttributeMetric("rated_lifetime", accumulated, specified),
        )]

    return [AttributeFact(key=key, label=label, value=f"{accumulated:,}", signal=signal)]


def _nvme_rows(data: dict) -> list[AttributeFact]:
    """Rows from nvme_smart_health_information_log."""
    log = data.get("nvme_smart_health_information_log", {})
    rows = []

    crit = log.get("critical_warning")
    if crit is not None:
        rows.append(AttributeFact(
            key="critical_warning",
            label="Critical Warning",
            value=f"0x{crit:02x}",
            drive_report="ok" if crit == 0 else "failed",
        ))

    temp_kelvin = log.get("temperature")
    if temp_kelvin is not None:
        rows.append(AttributeFact(key="temperature", label="Temperature", value=f"{temp_kelvin - 273}°C", signal="temp"))

    spare = log.get("available_spare")
    threshold = log.get("available_spare_threshold")
    if spare is not None:
        rows.append(AttributeFact(
            key="available_spare",
            label="Available Spare",
            value=f"{spare}%",
            detail=f"Threshold {threshold}%" if threshold is not None else None,
            metric=AttributeMetric("available_spare", spare, threshold),
        ))

    used = log.get("percentage_used")
    if used is not None:
        rows.append(AttributeFact(
            key="percentage_used",
            label="Percentage Used",
            value=f"{used}%",
            metric=AttributeMetric("percentage_used", used),
        ))

    media_errors = log.get("media_errors")
    if media_errors is not None:
        rows.append(AttributeFact(key="media_errors", label="Media Errors", value=f"{media_errors:,}", signal="uncorrected"))

    poh = log.get("power_on_hours")
    if poh is not None:
        rows.append(AttributeFact(key="power_on_hours", label="Power-On Hours", value=f"{poh:,}", signal="power_on_hours"))

    power_cycles = log.get("power_cycles")
    if power_cycles is not None:
        rows.append(AttributeFact(key="power_cycles", label="Power Cycles", value=f"{power_cycles:,}"))

    unsafe = log.get("unsafe_shutdowns")
    if unsafe is not None:
        rows.append(AttributeFact(key="unsafe_shutdowns", label="Unsafe Shutdowns", value=f"{unsafe:,}"))

    err_entries = log.get("num_err_log_entries")
    if err_entries is not None:
        rows.append(AttributeFact(
            key="error_log_entries",
            label="Error Log Entries",
            value=f"{err_entries:,}",
            metric=AttributeMetric("error_log_entries", err_entries),
        ))

    return rows
