"""
collector.py — Drive collector.

Discovers drives via the scan probe, runs traits and telemetry probes for
each, and maintains a live registry of DriveState objects keyed by GUID.

The collector runs a background daemon thread that wakes every _TICK_INTERVAL
seconds and checks, per drive, whether each channel ("telemetry", "snapshot",
"vitals") is due. Each channel has its own interval (config.yaml: collector.poll_intervals)
and drives are staggered evenly across each interval via a phase derived from
the drive's position in the sorted GUID list — see _compute_next_due. Drive
discovery (scan + reconciliation) runs on its own, non-staggered interval
(collector.scan_interval).

GUIDs are derived from the drive's serial number (uuid5), so they are stable
across reboots even if device paths change. Drives with no serial fall back
to the device name as the key.

Discovery is split from steady-state polling:
  - New descriptors (not seen before) go through _discover(), which runs traits
    on all candidates, groups by GUID, scores by data completeness, and picks
    the best access path. All paths are stored in DriveState.attachment.descriptors.
  - Known descriptors (already in attachment.descriptors of an existing state)
    just confirm the drive is still present — no re-probing needed.
  - Gone drives (GUIDs absent from the scan) are removed from the registry.
"""

import json
import math
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime

import db
from analysis.descriptor_rank import score_descriptor
from models import DriveContext, DriveDescriptor, DriveSnapshot, DriveState, DriveTraits, DriveVitals
from probes.scan import smartctl_scan
from probes.traits import smartctl_traits
from probes.telemetry import smartctl_telemetry
from probes.vitals import block_device, hwmon_temp, smartctl_vitals, sysfs_io

_GUID_NAMESPACE = uuid.UUID("d1a3ec4f-8b2a-4c5e-9f7d-6e8a2b1c3d4e")

# How often the background loop wakes to check for due channels.
_TICK_INTERVAL = 1.0

# Telemetry probes run every time the "telemetry" channel fires, in order, each
# enriching the DriveSnapshot the previous one returned. One entry today;
# dotted-path config loading for multiple probes is target design (see Project
# Status).
_TELEMETRY_PROBES = [smartctl_telemetry]

# Vitals probes run every time the "vitals" channel fires, in order, each
# enriching the DriveVitals the previous one returned. hwmon runs first and,
# if it supplies a temperature, smartctl_vitals leaves temp/temp_source alone.
_VITALS_PROBES = [hwmon_temp, smartctl_vitals, sysfs_io]


def _assign_guid(traits: DriveTraits, descriptor: DriveDescriptor) -> str:
    """Return a stable GUID for a drive, keyed on serial number if available."""
    key = traits.serial or descriptor.device_name
    return str(uuid.uuid5(_GUID_NAMESPACE, key))


class Collector:
    def __init__(self, scan_interval: int, poll_intervals: dict[str, int]):
        self._scan_interval = scan_interval
        self._poll_intervals = poll_intervals  # {"telemetry": ..., "snapshot": ...}
        self._drive_states: dict[str, DriveState] = {}
        self._phase_fractions: dict[str, float] = {}
        self._scan_due: float = time.time()
        # Per-drive, per-channel ("telemetry", "snapshot", "vitals") next-due times,
        # epoch seconds. Collector-internal scheduling state, not part of DriveState.
        self._schedules: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()
        self._poll_lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="collector")
        self._polling = False
        self._last_polled_at: datetime | None = None

    def start(self) -> None:
        """Start the background poll loop. Ticks immediately on first call."""
        self._thread.start()

    def get_drive_states(self) -> list[DriveState]:
        """Return a snapshot of all current drive states."""
        with self._lock:
            return list(self._drive_states.values())

    def set_drive_label(self, guid: str, label: str | None) -> bool:
        """Update a drive's user-assigned label. Returns False if the drive is unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            if state is None:
                return False
            state.label = label
        db.set_drive_label(guid, label)
        return True

    def trigger_poll(self) -> None:
        """Force an immediate telemetry refresh for all known drives, blocking until complete."""
        now = time.time()
        with self._lock:
            guids = list(self._drive_states.keys())
        for guid in guids:
            sched = self._schedules.get(guid)
            if sched:
                sched["telemetry"] = now
        self._tick()

    def get_status(self) -> dict:
        """Return the collector's current poll status."""
        with self._lock:
            return {
                "polling": self._polling,
                "last_polled_at": self._last_polled_at,
            }

    def _loop(self) -> None:
        while True:
            self._tick()
            time.sleep(_TICK_INTERVAL)

    def _tick(self) -> None:
        with self._poll_lock:
            with self._lock:
                self._polling = True
            try:
                self._do_tick()
            finally:
                with self._lock:
                    self._polling = False

    def _do_tick(self) -> None:
        now = time.time()

        if now >= self._scan_due:
            self._run_scan(now)
            self._scan_due = now + self._scan_interval

        with self._lock:
            active_states = list(self._drive_states.values())

        for state in active_states:
            self._maybe_run_channel(state, "telemetry", now)
            self._maybe_run_channel(state, "snapshot", now)
            self._maybe_run_channel(state, "vitals", now)

    def _maybe_run_channel(self, state: DriveState, channel: str, now: float) -> None:
        """Run a drive's channel if due, then schedule its next phase-staggered slot."""
        guid = state.context.guid
        sched = self._schedules[guid]
        if now < sched[channel]:
            return
        if channel == "telemetry":
            self._run_telemetry(state, now)
        elif channel == "snapshot":
            self._run_snapshot(state, now)
        elif channel == "vitals":
            self._run_vitals(state, now)
        sched[channel] = self._compute_next_due(guid, channel, now)

    def _compute_next_due(self, guid: str, channel: str, now: float) -> float:
        """
        Return the next due time for a drive's channel on a phase-staggered grid.

        Each drive has a phase fraction (its index in the sorted GUID list, divided
        by drive count) so drives spread evenly across the interval instead of
        clumping. If the next natural slot is less than half an interval away
        (e.g. right after a forced refresh), skip to the following slot — this is
        the only debounce needed; there's no separate cooldown state.
        """
        interval = self._poll_intervals[channel]
        phase = self._phase_fractions.get(guid, 0.0) * interval
        k = math.floor((now - phase) / interval) + 1
        next_due = phase + k * interval
        if next_due - now < 0.5 * interval:
            next_due += interval
        return next_due

    def _recompute_phase_fractions(self) -> None:
        """Recompute each drive's phase fraction from its position in the sorted GUID list."""
        with self._lock:
            guids = sorted(self._drive_states.keys())
        n = len(guids)
        self._phase_fractions = {guid: i / n for i, guid in enumerate(guids)} if n else {}

    def _run_scan(self, now: float) -> None:
        descriptors = smartctl_scan.run()
        self._reconcile_descriptors(descriptors, now)

    def _run_telemetry(self, state: DriveState, now: float) -> None:
        """Run the telemetry probe chain for a drive and record signals + heartbeat."""
        snapshot = DriveSnapshot()
        for probe in _TELEMETRY_PROBES:
            snapshot = probe.run(snapshot, state.context)
        with self._lock:
            state.snapshot = snapshot
            self._last_polled_at = datetime.now()

        captured_at = snapshot.telemetry.last_polled_at.isoformat()
        db.record_signals(state.context.guid, captured_at, asdict(snapshot.telemetry.signals))
        db.record_heartbeat(state.context.guid, captured_at, snapshot.telemetry.signals.temp)

    def _run_snapshot(self, state: DriveState, now: float) -> None:
        """Persist the most recent telemetry run's raw probe output, if any."""
        if not state.snapshot.extras:
            return
        captured_at = state.snapshot.telemetry.last_polled_at.isoformat()
        db.record_raw_snapshot(
            state.context.guid, captured_at, "smartctl_telemetry", json.dumps(state.snapshot.extras)
        )

    def _run_vitals(self, state: DriveState, now: float) -> None:
        """Run the vitals probe chain for a drive and record a vitals row."""
        vitals = DriveVitals(captured_at=datetime.now())
        for probe in _VITALS_PROBES:
            vitals = probe.run(vitals, state)

        with self._lock:
            state.vitals = vitals

        db.record_vitals(state.context.guid, vitals.captured_at.isoformat(), vitals.temp, vitals.temp_source, vitals.io)

    def _reconcile_descriptors(self, descriptors: list[DriveDescriptor], now: float) -> None:
        """Partition scan results into known/unknown, discover new drives, and remove gone ones."""
        with self._lock:
            known_keys: dict[tuple[str, str], str] = {
                (d.device_name, d.access_type): guid
                for guid, state in self._drive_states.items()
                for d in state.attachment.descriptors
            }

        matched_guids: set[str] = set()
        unknown: list[DriveDescriptor] = []

        for d in descriptors:
            key = (d.device_name, d.access_type)
            if key in known_keys:
                matched_guids.add(known_keys[key])
            else:
                unknown.append(d)

        if unknown:
            self._discover(unknown, matched_guids, now)

        self._remove_gone_drives(matched_guids)
        self._recompute_phase_fractions()

    def _discover(self, descriptors: list[DriveDescriptor], matched_guids: set[str], now: float) -> None:
        """Run traits on unknown descriptors, deduplicate by GUID, and create/update states."""
        probed: list[tuple[DriveDescriptor, DriveTraits, str]] = []
        for d in descriptors:
            traits = smartctl_traits.run(d)
            guid = _assign_guid(traits, d)
            probed.append((d, traits, guid))

        # Group by GUID — multiple descriptors may resolve to the same physical drive
        groups: dict[str, list[tuple[DriveDescriptor, DriveTraits]]] = {}
        for d, traits, guid in probed:
            groups.setdefault(guid, []).append((d, traits))

        for guid, group in groups.items():
            group.sort(key=lambda dt: score_descriptor(dt[0], dt[1]), reverse=True)
            best_descriptor, best_traits = group[0]
            all_descriptors = [d for d, _ in group]
            self._register_drive(guid, best_descriptor, best_traits, all_descriptors, matched_guids, now)

    def _register_drive(
        self,
        guid: str,
        best_descriptor: DriveDescriptor,
        best_traits: DriveTraits,
        all_descriptors: list[DriveDescriptor],
        matched_guids: set[str],
        now: float,
    ) -> None:
        """Create a new DriveState or append newly discovered paths to an existing one."""
        with self._lock:
            if guid in self._drive_states:
                self._append_descriptors(self._drive_states[guid], all_descriptors)
            else:
                context = DriveContext(guid=guid, descriptor=best_descriptor, traits=best_traits)
                state = DriveState(context=context)
                state.traits = best_traits
                state.attachment.descriptors = all_descriptors
                state.attachment.active_index = 0
                state.attachment.block_device = block_device.run(best_traits.serial)
                record = db.get_drive_record(guid)
                state.label = record["label"] if record else None
                self._drive_states[guid] = state
                # All channels are due immediately so a newly discovered drive
                # gets telemetry (and a baseline raw snapshot + vitals reading)
                # in this same tick.
                self._schedules[guid] = {"telemetry": now, "snapshot": now, "vitals": now}
        matched_guids.add(guid)

        db.upsert_drive_record(
            guid=guid,
            serial=best_traits.serial,
            model=best_traits.model,
            capacity_bytes=best_traits.capacity_bytes,
            drive_type=best_traits.drive_type.value if best_traits.drive_type else None,
            first_seen=datetime.now().isoformat(),
        )

    def _append_descriptors(self, state: DriveState, descriptors: list[DriveDescriptor]) -> None:
        """Add any descriptors not already recorded to a drive's attachment."""
        existing = {(d.device_name, d.access_type) for d in state.attachment.descriptors}
        for d in descriptors:
            if (d.device_name, d.access_type) not in existing:
                state.attachment.descriptors.append(d)

    def _remove_gone_drives(self, matched_guids: set[str]) -> None:
        """Remove drives from the registry that were absent from the latest scan."""
        with self._lock:
            gone = [g for g in self._drive_states if g not in matched_guids]
            for g in gone:
                del self._drive_states[g]
                self._schedules.pop(g, None)
