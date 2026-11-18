"""
analysis.self_tests — Every self-test DriveCheck has seen in a drive's own
log (drive_self_tests), judged when served: each test's kind (short,
conveyance, long (extended), selective), how many power-on hours ago it ran, whether
the drive's log still lists it, and the latest finished test of each kind —
recent or not, by the self_tests.recent_hours settings.

Who started a test doesn't matter (DriveCheck, smartd, a vendor tool, a
previous owner): the drive ran it and logged the result. Ages are power-on
hours, the only clock the log has, so a drive that sat unpowered looks more
recently tested than the calendar says.

Not part of the health score: a missing or old test is a coverage gap, not a
sign of failure. Only the latest test's failure is scored
(analysis.health.factors.self_test).
"""

from settings import cfg

ATA_HOURS_WRAP = 65536

# Test kind by protocol and type code. ATA: 1-4 offline, 129-132 the same
# tests run captive. SCSI: 1/2 background short/long, 5/6 foreground.
_KINDS = {
    "ata": {1: "short", 129: "short", 2: "long", 130: "long",
            3: "conveyance", 131: "conveyance", 4: "selective", 132: "selective"},
    "scsi": {1: "short", 5: "short", 2: "long", 6: "long"},
}
LATEST_KINDS = ("short", "conveyance", "long")

cfg.register("self_tests.recent_hours.short",
    default=168, type="int", label="Recent short test",
    section="Self-tests",
    description="Power-on hours a passed short self-test counts as recent (the drive card's S light).",
    tooltip="Ages are power-on hours, the only clock the drive's self-test log has: a drive "
            "that sat unpowered looks more recently tested than the calendar says. 168 h is a week of running.",
    min=1, max=100000, restart_required=False,
)
cfg.register("self_tests.recent_hours.long",
    default=1000, type="int", label="Recent long test",
    section="Self-tests",
    description="Power-on hours a passed Long (Extended) self-test — the full-surface one — counts as recent "
                "(the drive card's L light).",
    tooltip="Ages are power-on hours, the only clock the drive's self-test log has: a drive "
            "that sat unpowered looks more recently tested than the calendar says. "
            "1,000 h is about six weeks of running.",
    min=1, max=100000, restart_required=False,
)


def recent_hours() -> dict[str, int]:
    """The configured "recent" window per test kind, in power-on hours."""
    return {kind: cfg.get(f"self_tests.recent_hours.{kind}") for kind in ("short", "long")}


def build_self_tests(rows: list[dict], current_poh: int | None, recent: dict[str, int] | None = None,
                     latest_read_at: str | None = None) -> dict:
    """The served view of a drive's drive_self_tests rows (newest first, as
    db.get_self_tests gives them), against its current power-on hours and the
    latest full read's time:

        {"entries": [row + kind, hours, age_hours, in_drive_log],
         "latest": {kind: entry + recent | None for short/conveyance/long},
         "hours_reset": bool, "log_seen_at": str | None, "log_missing": bool}

    hours is the entry's power-on hours with ATA's 16-bit wrap undone against
    current_poh. age_hours is None when it can't be told: no current hours, or
    the entry ran at more hours than the drive has now (its counter was reset,
    e.g. a refurbished drive) — hours_reset says that was seen.

    in_drive_log: the newest read that listed any entries listed this one.
    Not the latest full read: smartctl leaves the log out of some reads (a
    SAS drive reporting itself failing, exit status bit 3), which says
    nothing about what the log still holds.

    log_seen_at is that newest read's time; log_missing says the latest full
    read (latest_read_at) came after it — the drive listed tests before and
    now lists none, so what's shown may be out of date. Logs don't empty on
    their own: in practice the drive stopped returning it (seen on a failing
    NETAPP SAS drive: "scsi response fails sanity test").

    latest skips aborted/interrupted tests (drive_report "marginal"): they
    didn't finish, so they neither pass nor fail. A failed one counts. recent
    (power-on hours per kind, recent_hours() when None) marks whether it ran
    within its kind's window; None for a kind without one or an unknown age."""
    if recent is None:
        recent = recent_hours()
    log_seen_at = max((r["last_seen_at"] for r in rows), default=None)
    log_missing = log_seen_at is not None and latest_read_at is not None and latest_read_at > log_seen_at
    entries = []
    for row in rows:
        hours = _unwrap(row["protocol"], row["power_on_hours"], current_poh)
        age = current_poh - hours if current_poh is not None and hours <= current_poh else None
        entries.append({
            **row,
            "kind": _KINDS.get(row["protocol"], {}).get(row["type_code"]),
            "hours": hours,
            "age_hours": age,
            "in_drive_log": row["last_seen_at"] >= log_seen_at,
        })
    hours_reset = current_poh is not None and any(e["hours"] > current_poh for e in entries)
    # Newest first; ageless entries last, in the order rows came (stable sort).
    entries.sort(key=lambda e: (e["age_hours"] is None, e["age_hours"] or 0))
    latest = {}
    for kind in LATEST_KINDS:
        entry = next((e for e in entries if e["kind"] == kind and e["drive_report"] != "marginal"), None)
        if entry is not None:
            window = recent.get(kind)
            entry = {**entry, "recent": None if window is None or entry["age_hours"] is None
                     else entry["age_hours"] <= window}
        latest[kind] = entry
    return {"entries": entries, "latest": latest, "hours_reset": hours_reset,
            "log_seen_at": log_seen_at, "log_missing": log_missing}


def _unwrap(protocol: str, hours: int, current_poh: int | None) -> int:
    """ATA logs keep the low 16 bits of the power-on hours, so past 65,535
    hours an entry's real hours are the latest value ≤ the drive's current
    hours with those low bits. SCSI logs the full count."""
    if protocol != "ata" or current_poh is None or current_poh < ATA_HOURS_WRAP:
        return hours
    return current_poh - (current_poh - hours) % ATA_HOURS_WRAP
