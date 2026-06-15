"""
analysis.smart_attributes — Build per-attribute SMART rows for the Health ->
SMART attributes sub-page.

Takes the raw smartctl JSON plus the already-computed DCSignals/DriveHealth (so
attributes that map onto a DCSignals field reuse its signal_flags entry — one
threshold definition, not two) and returns AttributeRow entries ready for the
frontend to render directly.
"""

from analysis.severity import flag
from drive_models import AttributeRow, DCSignals, DriveHealth, DriveType

# ATA SMART attribute IDs that map onto a DCSignals field — reuse its signal_flags
# entry instead of re-deriving a threshold here.
_ATA_SIGNAL_IDS = {5: "reallocated", 190: "temp", 194: "temp", 197: "pending", 198: "uncorrected"}


def build_attribute_rows(data: dict, drive_type: DriveType, signals: DCSignals, health: DriveHealth) -> list[AttributeRow]:
    """Build display-ready, classified attribute rows for a drive's raw SMART data."""
    if drive_type == DriveType.NVME:
        return _nvme_rows(data, health)
    elif drive_type == DriveType.SAS:
        return _scsi_rows(data, health)
    else:
        return _ata_rows(data, health)


def _ata_rows(data: dict, health: DriveHealth) -> list[AttributeRow]:
    """Full raw attribute dump from ata_smart_attributes.table — one row per entry."""
    rows = []
    for entry in data.get("ata_smart_attributes", {}).get("table", []):
        attr_id = entry.get("id")
        raw = entry.get("raw", {})
        value, worst, thresh = entry.get("value"), entry.get("worst"), entry.get("thresh")

        signal = _ATA_SIGNAL_IDS.get(attr_id)
        if signal:
            status = health.signal_flags.get(signal, "ok")
        elif entry.get("when_failed"):
            status = "crit"
        elif thresh and value is not None and value <= thresh:
            status = "crit"
        else:
            status = "ok"

        rows.append(AttributeRow(
            key=f"ata_{attr_id}",
            label=entry.get("name", f"Attribute {attr_id}").replace("_", " "),
            value=raw.get("string", str(raw.get("value", "—"))),
            status=status,
            detail=f"value {value} · worst {worst} · thresh {thresh}",
        ))
    return rows


def _scsi_rows(data: dict, health: DriveHealth) -> list[AttributeRow]:
    """Curated rows from SCSI/SAS error counters and log pages."""
    rows = []

    smart_status = data.get("smart_status", {})
    passed = smart_status.get("passed")
    rows.append(AttributeRow(
        key="smart_status",
        label="SMART Overall Status",
        value="PASSED" if passed else "FAILED" if passed is False else "—",
        status="crit" if passed is False else "ok",
        detail=smart_status.get("scsi", {}).get("ie_string") if passed is False else None,
    ))

    temp = data.get("temperature", {})
    if temp.get("current") is not None:
        trip = temp.get("drive_trip")
        rows.append(AttributeRow(
            key="temperature",
            label="Temperature",
            value=f"{temp['current']}°C",
            status=health.signal_flags.get("temp", "ok"),
            detail=f"Trip threshold {trip}°C" if trip is not None else None,
        ))

    poh = data.get("power_on_time", {}).get("hours")
    if poh is not None:
        rows.append(AttributeRow(
            key="power_on_hours",
            label="Power-On Hours",
            value=f"{poh:,}",
            status="ok",
        ))

    defects = data.get("scsi_grown_defect_list")
    if defects is not None:
        rows.append(AttributeRow(
            key="grown_defect_list",
            label="Grown Defect List",
            value=f"{defects:,}",
            status=health.signal_flags.get("reallocated", "ok"),
        ))

    error_log = data.get("scsi_error_counter_log")
    if error_log:
        read_u   = error_log.get("read",   {}).get("total_uncorrected_errors") or 0
        write_u  = error_log.get("write",  {}).get("total_uncorrected_errors") or 0
        verify_u = error_log.get("verify", {}).get("total_uncorrected_errors") or 0
        rows.append(AttributeRow(
            key="uncorrected_errors",
            label="Uncorrected Errors",
            value=f"{read_u + write_u + verify_u:,}",
            status=health.signal_flags.get("uncorrected", "ok"),
            detail=f"Read {read_u} · Write {write_u} · Verify {verify_u}",
        ))

    cycles = data.get("scsi_start_stop_cycle_counter", {})
    rows += _lifetime_cycle_row(
        cycles, "load_unload_cycles", "Load/Unload Cycles",
        "accumulated_load_unload_cycles", "specified_load_unload_count_over_device_lifetime",
    )
    rows += _lifetime_cycle_row(
        cycles, "start_stop_cycles", "Start/Stop Cycles",
        "accumulated_start_stop_cycles", "specified_cycle_count_over_device_lifetime",
    )

    for i in range(3):
        entry = data.get(f"scsi_self_test_{i}")
        if entry:
            rows.append(_self_test_row(i, entry))

    return rows


def _lifetime_cycle_row(cycles: dict, key: str, label: str, accumulated_field: str, specified_field: str) -> list[AttributeRow]:
    """Build a row comparing an accumulated cycle count to its rated lifetime spec."""
    accumulated = cycles.get(accumulated_field)
    if accumulated is None:
        return []

    specified = cycles.get(specified_field)
    if specified:
        ratio = accumulated / specified
        return [AttributeRow(
            key=key,
            label=label,
            value=f"{accumulated:,} / {specified:,}",
            status=flag(ratio, warn_gte=0.8, crit_gte=1.0),
            detail=f"{ratio * 100:.0f}% of rated lifetime",
        )]

    return [AttributeRow(key=key, label=label, value=f"{accumulated:,}", status="ok")]


def _self_test_row(index: int, entry: dict) -> AttributeRow:
    """Build a row for one scsi_self_test_N entry (most recent self-tests)."""
    code = entry.get("code", {}).get("string", "Self-test")
    result = entry.get("result", {})
    result_str = result.get("string", "Unknown")
    result_val = result.get("value", 0)

    if "fail" in result_str.lower():
        status = "crit"
    elif result_val != 0:
        status = "warn"
    else:
        status = "ok"

    detail_parts = []
    poh = entry.get("power_on_time", {}).get("hours")
    if poh is not None:
        detail_parts.append(f"at {poh:,}h")
    sense_key = entry.get("sense_key", {}).get("string")
    if sense_key:
        detail_parts.append(sense_key)

    return AttributeRow(
        key=f"self_test_{index}",
        label=f"Self-Test: {code}",
        value=result_str,
        status=status,
        detail=" · ".join(detail_parts) or None,
    )


def _nvme_rows(data: dict, health: DriveHealth) -> list[AttributeRow]:
    """Rows from nvme_smart_health_information_log."""
    log = data.get("nvme_smart_health_information_log", {})
    rows = []

    crit = log.get("critical_warning")
    if crit is not None:
        rows.append(AttributeRow(
            key="critical_warning",
            label="Critical Warning",
            value=f"0x{crit:02x}",
            status="ok" if crit == 0 else "crit",
        ))

    temp_kelvin = log.get("temperature")
    if temp_kelvin is not None:
        rows.append(AttributeRow(
            key="temperature",
            label="Temperature",
            value=f"{temp_kelvin - 273}°C",
            status=health.signal_flags.get("temp", "ok"),
        ))

    spare = log.get("available_spare")
    threshold = log.get("available_spare_threshold")
    if spare is not None:
        rows.append(AttributeRow(
            key="available_spare",
            label="Available Spare",
            value=f"{spare}%",
            status="warn" if threshold is not None and spare <= threshold else "ok",
            detail=f"Threshold {threshold}%" if threshold is not None else None,
        ))

    used = log.get("percentage_used")
    if used is not None:
        rows.append(AttributeRow(
            key="percentage_used",
            label="Percentage Used",
            value=f"{used}%",
            status=flag(used, warn_gte=80, crit_gte=100),
        ))

    media_errors = log.get("media_errors")
    if media_errors is not None:
        rows.append(AttributeRow(
            key="media_errors",
            label="Media Errors",
            value=f"{media_errors:,}",
            status=health.signal_flags.get("uncorrected", "ok"),
        ))

    poh = log.get("power_on_hours")
    if poh is not None:
        rows.append(AttributeRow(key="power_on_hours", label="Power-On Hours", value=f"{poh:,}", status="ok"))

    power_cycles = log.get("power_cycles")
    if power_cycles is not None:
        rows.append(AttributeRow(key="power_cycles", label="Power Cycles", value=f"{power_cycles:,}", status="ok"))

    unsafe = log.get("unsafe_shutdowns")
    if unsafe is not None:
        rows.append(AttributeRow(key="unsafe_shutdowns", label="Unsafe Shutdowns", value=f"{unsafe:,}", status="ok"))

    err_entries = log.get("num_err_log_entries")
    if err_entries is not None:
        rows.append(AttributeRow(
            key="error_log_entries",
            label="Error Log Entries",
            value=f"{err_entries:,}",
            status=flag(err_entries, warn_gte=1),
        ))

    return rows
