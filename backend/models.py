"""
models.py — Core data models for drivecheck.

All dataclasses are mutable by default so telemetry probes can enrich a
DriveSnapshot incrementally as it passes through the probe chain.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class DriveType(Enum):
    """Broad drive technology category, inferred from smartctl output."""
    HDD     = "HDD"
    SSD     = "SSD"
    NVME    = "NVMe"
    SAS     = "SAS"
    UNKNOWN = "Unknown"


# ---------------------------------------------------------------------------
# DriveDescriptor
# Minimal identity passed to traits and telemetry probes so they know what to query.
# Produced by scan probes; not persisted to SQLite.
# ---------------------------------------------------------------------------

@dataclass
class DriveDescriptor:
    """Minimal identity needed to interrogate a drive."""
    device_name: str        # e.g. "/dev/sda" or "/dev/bus/1"
    access_type: str        # e.g. "scsi", "megaraid,0", "ata" — passed as -d flag
    info_name: str          # human-readable, e.g. "/dev/bus/1 [megaraid_disk_00]"


# ---------------------------------------------------------------------------
# DriveTraits
# Intrinsic physical characteristics as reported by drive firmware.
# Stable — shouldn't change between polls for the same drive.
# ---------------------------------------------------------------------------

@dataclass
class DriveTraits:
    """Intrinsic physical characteristics as reported by drive firmware."""
    serial: str             | None = None
    manufacturer: str       | None = None
    model: str              | None = None
    capacity_bytes: int     | None = None
    drive_type: DriveType   | None = None
    form_factor: str        | None = None   # "3.5 inches" | "2.5 inches" | etc.
    rpm: int                | None = None   # None for SSDs/NVMe
    bus: str                | None = None   # "SATA III · 6 Gb/s" | "SAS (SPL-4)" | etc.


# ---------------------------------------------------------------------------
# DriveContext
# Collector-assembled identity. Universal context object passed to traits
# probes, telemetry probes, operations, and jobs. Stable across polls for the same drive.
# guid is assigned on first detection and never changes.
# ---------------------------------------------------------------------------

@dataclass
class DriveContext:
    """Collector-assembled drive identity. Passed to probes, operations, and jobs."""
    guid: str
    descriptor: DriveDescriptor
    traits: DriveTraits = field(default_factory=DriveTraits)


# ---------------------------------------------------------------------------
# DriveAttachment
# How the drive is attached right now — ephemeral, can change across reboots.
# ---------------------------------------------------------------------------

@dataclass
class DriveAttachment:
    """How the drive is attached to this system."""
    descriptors: list[DriveDescriptor] = field(default_factory=list)
    active_index: int = 0       # index into descriptors; matches context.descriptor
    is_mounted: bool  = False

    @property
    def primary_descriptor(self) -> "DriveDescriptor | None":
        """Return the active descriptor, or None if no descriptors are recorded yet."""
        if not self.descriptors:
            return None
        return self.descriptors[self.active_index]


# ---------------------------------------------------------------------------
# DCSignals
# Drivecheck-normalized health signals mapped from raw protocol data.
# Named without a dc_ prefix — the DCSignals namespace makes them unambiguous.
# Not every signal is available for every drive type; None means not applicable
# or not yet read.
# ---------------------------------------------------------------------------

@dataclass
class DCSignals:
    """
    Drivecheck-normalized health signals.

    These are mapped FROM raw protocol data (ATA SMART attributes, SCSI error
    counters, etc.) into a common representation. The mapping lives in the
    telemetry probes. These fields are what the card grid, overview tiles, and
    trend queries consume.

    ATA source          → field              ← SCSI/SAS source
    ────────────────────────────────────────────────────────────────
    attr 09 raw         → power_on_hours     ← power_on_time.hours
    attr BE/C2 raw      → temp               ← temperature.current
    attr 05 raw         → reallocated        ← scsi_grown_defect_list
    attr C5 raw         → pending            ← (closest: read uncorrected errors)
    attr C6 raw         → uncorrected        ← scsi_error_counter_log uncorrected
    attr C7 raw         → crc_errors         ← non-medium error count
    attr C4 raw         → reallocated_events ← (ATA only; None for SAS)
    smart overall       → smart_passed       ← smart_status.passed
    """
    power_on_hours: int      | None = None
    temp: int                | None = None
    reallocated: int         | None = None
    pending: int             | None = None   # ATA only (0xC5); None for SAS/NVMe
    uncorrected: int         | None = None
    crc_errors: int          | None = None
    reallocated_events: int  | None = None
    load_unload_cycles: int  | None = None   # SAS only; None for ATA/NVMe
    smart_passed: bool       | None = None


# ---------------------------------------------------------------------------
# DriveTelemetry
# Live readings from the most recent collector poll.
# ---------------------------------------------------------------------------

@dataclass
class DriveTelemetry:
    """Live readings from the most recent collector poll."""
    signals: DCSignals = field(default_factory=DCSignals)
    last_polled_at: datetime | None = None


# ---------------------------------------------------------------------------
# DriveHealth
# Derived health signals computed after each poll.
# ---------------------------------------------------------------------------

@dataclass
class DriveHealth:
    """Derived health signals, computed by the collector after each poll."""
    health_pct: int     | None = None
    health_status: str  | None = None   # "Healthy" | "Degraded" | "Failing" | None (Unrated)
    signal_flags: dict[str, str] = field(default_factory=dict)  # DCSignals field name -> "ok" | "warn" | "crit"


# ---------------------------------------------------------------------------
# AttributeRow
# One row in the SMART attributes sub-page — a single classified attribute,
# computed by analysis.smart_attributes from the raw protocol data. Display-ready:
# the frontend renders these fields directly without further interpretation.
# ---------------------------------------------------------------------------

@dataclass
class AttributeRow:
    """One row in the SMART attributes sub-page."""
    key: str
    label: str
    value: str
    status: str            # "ok" | "warn" | "crit"
    detail: str | None = None


# ---------------------------------------------------------------------------
# ProbeRecord
# Lightweight log entry written by each probe as it runs.
# ---------------------------------------------------------------------------

@dataclass
class ProbeRecord:
    """Record of a single probe execution."""
    probe: str                          # e.g. "drivecheck.probes.smartctl_telemetry"
    captured_at: datetime = field(default_factory=lambda: datetime.now())
    success: bool = True
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# DriveSnapshot
# Point-in-time capture of a single collector poll. Persisted to SQLite for
# historical trend queries. One snapshot per poll per drive.
# ---------------------------------------------------------------------------

@dataclass
class DriveSnapshot:
    """Point-in-time capture of a drive's poll results. Persisted to SQLite."""
    telemetry: DriveTelemetry = field(default_factory=DriveTelemetry)
    health: DriveHealth = field(default_factory=DriveHealth)
    # Free-form bag for raw probe output — smartctl JSON, lsblk, vendor data, etc.
    # Anything without a first-class field lives here; the SMART tab renders it directly.
    extras: dict = field(default_factory=dict)
    probe_log: list[ProbeRecord] = field(default_factory=list)  # one entry per probe, in order


# ---------------------------------------------------------------------------
# DriveState
# Live in-memory view of a drive. Lives in the collector registry. Holds stable
# identity plus the current snapshot. Read by API endpoints; written only by
# the collector thread and probe chain.
# ---------------------------------------------------------------------------

@dataclass
class DriveState:
    """
    Live in-memory view of a drive as of the last collector poll.

    The current snapshot is built by passing a fresh DriveSnapshot through the
    telemetry probe chain each cycle; each probe receives and returns it,
    enriching it with whatever data it can provide.
    """
    # Stable identity (GUID + descriptor + traits). GUID is assigned on first
    # detection and is always present by the time a state object enters the registry.
    context: DriveContext

    traits: DriveTraits = field(default_factory=DriveTraits)
    attachment: DriveAttachment = field(default_factory=DriveAttachment)
    snapshot: DriveSnapshot = field(default_factory=DriveSnapshot)
