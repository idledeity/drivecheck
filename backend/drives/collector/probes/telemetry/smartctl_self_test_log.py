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

observed_self_tests() reads the same log as plain entries (type and result
codes, power-on hours) for the drive_self_tests table, which keeps every
entry DriveCheck has seen after the drive's log has rolled it out.
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


# ATA status values whose high nibble is 0xF are a test still running
# (e.g. 249 "Self-test routine in progress"); SCSI result 15 is the same.
_ATA_IN_PROGRESS = 0xF
_SCSI_IN_PROGRESS = 15


def observed_self_tests(data: dict) -> list[dict]:
    """The drive's finished self-test log entries as plain facts, newest
    first: {protocol, type_code, type, result_code, result, drive_report,
    power_on_hours, lba_first_failure}. Reads whichever log the read holds
    (ATA standard + extended, or SCSI), so it needs no drive type. Entries
    still running, or without power-on hours, are left out: their result or
    place in time isn't settled, as are ones without type or result codes
    (the table's key)."""
    if "scsi_self_test_0" in data:
        entries = [_scsi_entry(e) for e in _scsi_entries(data)]
    else:
        log = data.get("ata_smart_self_test_log", {})
        entries, seen = [], set()
        # The extended (GP) log can hold more entries than the 21 of the
        # standard one; both list the same tests, so keep each once.
        for table in (log.get("extended", {}).get("table", []), log.get("standard", {}).get("table", [])):
            for entry in map(_ata_entry, table):
                key = entry and (entry["type_code"], entry["power_on_hours"], entry["result_code"])
                if key and key not in seen:
                    seen.add(key)
                    entries.append(entry)
    return [e for e in entries if e is not None]


def _scsi_entries(data: dict) -> list[dict]:
    index, out = 0, []
    while (entry := data.get(f"scsi_self_test_{index}")) is not None:
        out.append(entry)
        index += 1
    return out


def _ata_entry(entry: dict) -> dict | None:
    status = entry.get("status", {})
    code = status.get("value")
    hours = entry.get("lifetime_hours")
    type_code = entry.get("type", {}).get("value")
    if hours is None or code is None or type_code is None or code >> 4 == _ATA_IN_PROGRESS:
        return None
    result = status.get("string", "Unknown")
    if status.get("passed") is False or "fail" in result.lower():
        report = "failed"
    elif "aborted" in result.lower() or "interrupted" in result.lower():
        report = "marginal"
    else:
        report = "ok"
    return {
        "protocol": "ata",
        "type_code": type_code,
        "type": entry.get("type", {}).get("string", "Self-test"),
        "result_code": code,
        "result": result,
        "drive_report": report,
        "power_on_hours": hours,
        "lba_first_failure": entry.get("lba"),
    }


def _scsi_entry(entry: dict) -> dict | None:
    result = entry.get("result", {})
    code = result.get("value")
    type_code = entry.get("code", {}).get("value")
    hours = entry.get("power_on_time", {}).get("hours")
    if (hours is None or code is None or type_code is None
            or code == _SCSI_IN_PROGRESS or entry.get("self_test_in_progress")):
        return None
    text = result.get("string", "Unknown")
    report = "failed" if "fail" in text.lower() else "marginal" if code != 0 else "ok"
    return {
        "protocol": "scsi",
        "type_code": type_code,
        "type": entry.get("code", {}).get("string", "Self-test"),
        "result_code": code,
        "result": text,
        "drive_report": report,
        "power_on_hours": hours,
        "lba_first_failure": entry.get("lba_first_failure", {}).get("value"),
    }
