"""
analysis.self_tests — Every self-test DriveCheck has seen in a drive's own
log (drive_self_tests), judged when served: which are extended (full-surface)
tests, how many power-on hours ago each ran, whether the drive's log still
lists it, and the latest extended test that ran to the end.

Who started a test doesn't matter (DriveCheck, smartd, a vendor tool, a
previous owner): the drive ran it and logged the result. Ages are power-on
hours, the only clock the log has, so a drive that sat unpowered looks more
recently tested than the calendar says.

Not part of the health score: a missing or old test is a coverage gap, not a
sign of failure. Only the latest test's failure is scored
(analysis.health.factors.self_test).
"""

ATA_HOURS_WRAP = 65536

# Full-surface tests by protocol: ATA 2 = Extended offline, 130 = Extended
# captive; SCSI 2 = Background long, 6 = Foreground long.
_EXTENDED_CODES = {"ata": {2, 130}, "scsi": {2, 6}}


def build_self_tests(rows: list[dict], current_poh: int | None, latest_read_at: str | None = None) -> dict:
    """The served view of a drive's drive_self_tests rows (newest first, as
    db.get_self_tests gives them), against its current power-on hours and
    the latest full read's time (what "still in the drive's log" means; the
    newest last_seen_at when None):

        {"entries": [row + extended, hours, age_hours, in_drive_log],
         "last_extended": entry | None, "hours_reset": bool}

    hours is the entry's power-on hours with ATA's 16-bit wrap undone against
    current_poh. age_hours is None when it can't be told: no current hours, or
    the entry ran at more hours than the drive has now (its counter was reset,
    e.g. a refurbished drive) — hours_reset says that was seen. last_extended
    skips aborted/interrupted tests (drive_report "marginal"), which didn't
    read the whole surface; a failed one counts, it ran far enough to fail."""
    if latest_read_at is None and rows:
        latest_read_at = max(r["last_seen_at"] for r in rows)
    entries = []
    for row in rows:
        hours = _unwrap(row["protocol"], row["power_on_hours"], current_poh)
        age = current_poh - hours if current_poh is not None and hours <= current_poh else None
        entries.append({
            **row,
            "extended": row["type_code"] in _EXTENDED_CODES.get(row["protocol"], ()),
            "hours": hours,
            "age_hours": age,
            "in_drive_log": row["last_seen_at"] >= latest_read_at,
        })
    hours_reset = current_poh is not None and any(e["hours"] > current_poh for e in entries)
    # Newest first; ageless entries last, in the order rows came (stable sort).
    entries.sort(key=lambda e: (e["age_hours"] is None, e["age_hours"] or 0))
    last_extended = next((e for e in entries if e["extended"] and e["drive_report"] != "marginal"), None)
    return {"entries": entries, "last_extended": last_extended, "hours_reset": hours_reset}


def _unwrap(protocol: str, hours: int, current_poh: int | None) -> int:
    """ATA logs keep the low 16 bits of the power-on hours, so past 65,535
    hours an entry's real hours are the latest value ≤ the drive's current
    hours with those low bits. SCSI logs the full count."""
    if protocol != "ata" or current_poh is None or current_poh < ATA_HOURS_WRAP:
        return hours
    return current_poh - (current_poh - hours) % ATA_HOURS_WRAP
