"""
probes.telemetry.smartctl_self_test_log — Parse the drive's own native SMART
self-test history from smartctl -a JSON, for the SMART attributes sub-page.

This is the drive's onboard log (smartctl -a), not DriveCheck's job history —
it can include self-tests that ran before DriveCheck ever touched the drive,
or that some other tool/the drive's own scheduler started. ATA exposes it as
a nested table (ata_smart_self_test_log.standard.table); SCSI/SAS exposes the
same idea as a series of numbered top-level keys (scsi_self_test_0,
scsi_self_test_1, ...) instead of an array, so _scsi_log scans until it hits
a gap rather than assuming a fixed count.

Facts only: each entry's result is recorded as the drive's own report
(drive_report "ok" | "marginal" | "failed"); analysis.smart_attributes decides
what that means. A helper for smartctl_telemetry, not a probe itself (no run()).
"""

import logging

from drives.drive_models import AttributeFact, DriveType

logger = logging.getLogger(__name__)


def parse_self_test_log(data: dict, drive_type: DriveType) -> list[AttributeFact]:
    """Facts for a drive's native self-test history, most recent first."""
    rows = _scsi_log(data) if drive_type == DriveType.SAS else _ata_log(data)
    logger.debug("parsed %d self-test log row(s)", len(rows))
    return rows


def _ata_log(data: dict) -> list[AttributeFact]:
    table = data.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])
    return [_ata_row(i, entry) for i, entry in enumerate(table)]


def _ata_row(index: int, entry: dict) -> AttributeFact:
    test_type = entry.get("type", {}).get("string", "Self-test")
    status_info = entry.get("status", {})
    result_str = status_info.get("string", "Unknown")

    # Every real smartctl failure string says "failure" (electrical/servo-seek/
    # read/unknown failure) — "fail" alone catches them. A bare "error" check
    # would also match the success string "Completed without error".
    if status_info.get("passed") is False or "fail" in result_str.lower():
        report = "failed"
    elif "aborted" in result_str.lower() or "interrupted" in result_str.lower():
        report = "marginal"
    else:
        report = "ok"

    poh = entry.get("lifetime_hours")
    return AttributeFact(
        key=f"ata_self_test_{index}",
        label=test_type,
        value=result_str,
        detail=f"at {poh:,}h" if poh is not None else None,
        drive_report=report,
    )


def _scsi_log(data: dict) -> list[AttributeFact]:
    rows = []
    index = 0
    while (entry := data.get(f"scsi_self_test_{index}")) is not None:
        rows.append(_scsi_row(index, entry))
        index += 1
    return rows


def _scsi_row(index: int, entry: dict) -> AttributeFact:
    code = entry.get("code", {}).get("string", "Self-test")
    result = entry.get("result", {})
    result_str = result.get("string", "Unknown")
    result_val = result.get("value", 0)

    if "fail" in result_str.lower():
        report = "failed"
    elif result_val != 0:
        report = "marginal"
    else:
        report = "ok"

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

    return AttributeFact(
        key=f"scsi_self_test_{index}",
        label=code,
        value=result_str,
        detail=" · ".join(detail_parts) or None,
        drive_report=report,
    )
