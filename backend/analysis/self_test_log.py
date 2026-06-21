"""
analysis.self_test_log — Build rows for the drive's own native SMART
self-test history, for the SMART attributes sub-page.

This is the drive's onboard log (smartctl -a), not DriveCheck's job history —
it can include self-tests that ran before DriveCheck ever touched the drive,
or that some other tool/the drive's own scheduler started. ATA exposes it as
a nested table (ata_smart_self_test_log.standard.table); SCSI/SAS exposes the
same idea as a series of numbered top-level keys (scsi_self_test_0,
scsi_self_test_1, ...) instead of an array, so _scsi_log scans until it hits
a gap rather than assuming a fixed count.
"""

import logging

from drives.drive_models import AttributeRow, DriveType

logger = logging.getLogger(__name__)


def build_self_test_log(data: dict, drive_type: DriveType) -> list[AttributeRow]:
    """Build display-ready rows for a drive's native self-test history, most recent first."""
    rows = _scsi_log(data) if drive_type == DriveType.SAS else _ata_log(data)
    logger.debug("built %d self-test log row(s)", len(rows))
    return rows


def _ata_log(data: dict) -> list[AttributeRow]:
    table = data.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])
    return [_ata_row(i, entry) for i, entry in enumerate(table)]


def _ata_row(index: int, entry: dict) -> AttributeRow:
    test_type = entry.get("type", {}).get("string", "Self-test")
    status_info = entry.get("status", {})
    result_str = status_info.get("string", "Unknown")

    if status_info.get("passed") is False or "fail" in result_str.lower() or "error" in result_str.lower():
        status = "crit"
    elif "aborted" in result_str.lower() or "interrupted" in result_str.lower():
        status = "warn"
    else:
        status = "ok"

    poh = entry.get("lifetime_hours")
    return AttributeRow(
        key=f"ata_self_test_{index}",
        label=test_type,
        value=result_str,
        status=status,
        detail=f"at {poh:,}h" if poh is not None else None,
    )


def _scsi_log(data: dict) -> list[AttributeRow]:
    rows = []
    index = 0
    while (entry := data.get(f"scsi_self_test_{index}")) is not None:
        rows.append(_scsi_row(index, entry))
        index += 1
    return rows


def _scsi_row(index: int, entry: dict) -> AttributeRow:
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
    lba = entry.get("lba_first_failure", {}).get("value")
    if lba is not None:
        detail_parts.append(f"LBA {lba:,}")

    return AttributeRow(
        key=f"scsi_self_test_{index}",
        label=code,
        value=result_str,
        status=status,
        detail=" · ".join(detail_parts) or None,
    )
