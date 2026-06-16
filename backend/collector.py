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

import importlib
import json
import math
import sys
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import asdict, fields, replace
from datetime import datetime
from types import ModuleType

import db
from analysis.descriptor_rank import score_descriptor
from drive_tools.timeout import ProbeTimeout
from drive_models import DriveContext, DriveDescriptor, DriveSnapshot, DriveState, DriveTraits, DriveVitals
from probes.vitals.block_device import run as resolve_block_device

_GUID_NAMESPACE = uuid.UUID("d1a3ec4f-8b2a-4c5e-9f7d-6e8a2b1c3d4e")

# How often the background loop wakes to check for due channels.
_TICK_INTERVAL = 1.0

# How often to check whether history pruning is due.
_PRUNE_INTERVAL = 86400


def _load_probes(dotted_paths: list[str]) -> list[ModuleType]:
    """Import and return each dotted-path probe module, in order."""
    return [importlib.import_module(path) for path in dotted_paths]


def _assign_guid(traits: DriveTraits, descriptor: DriveDescriptor) -> str:
    """Return a stable GUID for a drive, keyed on serial number if available."""
    key = traits.serial or descriptor.device_name
    return str(uuid.uuid5(_GUID_NAMESPACE, key))


def _merge_traits(base: DriveTraits, overlay: DriveTraits) -> DriveTraits:
    """Merge overlay onto base, overlay's non-None fields taking precedence.

    Used to combine results from multiple traits probes — last probe with a
    non-None value for a field wins, matching the "last probe has final
    authority" rule used for telemetry/vitals chains.
    """
    updates = {f.name: getattr(overlay, f.name) for f in fields(overlay) if getattr(overlay, f.name) is not None}
    return replace(base, **updates)


class Collector:
    def __init__(
        self,
        scan_interval: int,
        poll_intervals: dict[str, int],
        scan_probes: list[str],
        traits_probes: list[str],
        telemetry_probes: list[str],
        vitals_probes: list[str],
        keep_history_days: int,
        max_workers: int,
        probe_timeout: int,
    ):
        self._scan_interval = scan_interval
        self._poll_intervals = poll_intervals  # {"telemetry": ..., "snapshot": ...}
        self._scan_probes = _load_probes(scan_probes)
        self._traits_probes = _load_probes(traits_probes)
        self._telemetry_probes = _load_probes(telemetry_probes)
        self._vitals_probes = _load_probes(vitals_probes)
        self._keep_history_days = keep_history_days
        self._probe_timeout = probe_timeout
        self._drive_states: dict[str, DriveState] = {}
        self._phase_fractions: dict[str, float] = {}
        self._scan_due: float = time.time()
        # Initialized lazily on the first tick, from db.get_last_pruned_at() — db.init()
        # hasn't necessarily run yet at construction time.
        self._prune_due: float | None = None
        # Per-drive, per-channel ("telemetry", "snapshot", "vitals") next-due times,
        # epoch seconds. Collector-internal scheduling state, not part of DriveState.
        self._schedules: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()
        self._poll_lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="collector")
        self._stop_event = threading.Event()
        self._scanned = threading.Event()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="collector-poll")
        # (guid, channel) -> Future for work currently running on the executor,
        # guarded by self._lock.
        self._inflight: dict[tuple[str, str], Future] = {}

    def start(self) -> None:
        """Start the background poll loop."""
        self._thread.start()

    def stop(self) -> None:
        """Signal the background loop to stop and shut down the executor."""
        self._stop_event.set()
        self._thread.join(timeout=5)
        self._executor.shutdown(wait=False)

    def wait_for_scan(self) -> None:
        """Block until the first drive scan has completed.

        A no-op after the first scan — the underlying Event stays set, so later
        calls return immediately.
        """
        self._scanned.wait()

    def get_drive_states(self) -> list[DriveState]:
        """Return a snapshot of all current drive states."""
        with self._lock:
            return list(self._drive_states.values())

    def get_drive_context(self, guid: str) -> DriveContext | None:
        """Return the current DriveContext for a drive, or None if unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            return state.context if state else None

    def set_drive_label(self, guid: str, label: str | None) -> bool:
        """Update a drive's user-assigned label. Returns False if the drive is unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            if state is None:
                return False
            state.label = label
        db.set_drive_label(guid, label)
        return True

    def trigger_poll(self, guids: list[str] | None = None) -> bool:
        """Force an immediate telemetry refresh, blocking until complete.

        If guids is given, only those drives' telemetry channels are marked
        due, and False is returned if any guid is unknown. If guids is None,
        all known drives are refreshed.
        """
        now = time.time()
        with self._lock:
            known = set(self._drive_states.keys())
        if guids is not None:
            if not set(guids) <= known:
                return False
            target = guids
        else:
            target = list(known)
        for g in target:
            sched = self._schedules.get(g)
            if sched:
                sched["telemetry"] = now
        wait(self._tick())
        return True

    def trigger_scan(self) -> None:
        """Force an immediate drive scan, blocking until complete."""
        self._scan_due = 0
        wait(self._tick())

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception as e:
                print(f"[collector] tick failed: {e}", file=sys.stderr)
            self._stop_event.wait(_TICK_INTERVAL)

    def _tick(self) -> list[Future]:
        with self._poll_lock:
            return self._do_tick()

    def _do_tick(self) -> list[Future]:
        now = time.time()

        if now >= self._scan_due:
            with ProbeTimeout(self._probe_timeout):
                self._run_scan(now)
            self._scan_due = now + self._scan_interval
            self._scanned.set()

        if self._prune_due is None:
            last_pruned_at = db.get_last_pruned_at()
            self._prune_due = (
                datetime.fromisoformat(last_pruned_at).timestamp() + _PRUNE_INTERVAL
                if last_pruned_at is not None
                else now + _PRUNE_INTERVAL
            )

        if now >= self._prune_due:
            cutoff = datetime.fromtimestamp(now - self._keep_history_days * 86400).isoformat()
            db.prune_history(cutoff)
            db.set_last_pruned_at(datetime.fromtimestamp(now).isoformat())
            self._prune_due = now + _PRUNE_INTERVAL

        with self._lock:
            active_states = list(self._drive_states.values())

        futures: list[Future] = []
        for state in active_states:
            for channel in ("telemetry", "snapshot", "vitals", "traits"):
                future = self._maybe_run_channel(state, channel, now)
                if future is not None:
                    futures.append(future)
        return futures

    def _maybe_run_channel(self, state: DriveState, channel: str, now: float) -> Future | None:
        """Submit a drive's channel for execution if due, or return its in-flight future.

        If the channel is already running (from a previous tick that hasn't
        finished yet), returns that future rather than skipping silently — so
        callers like trigger_poll() that wait on the returned futures still
        block until in-flight work completes, even if they didn't submit it.

        The next phase-staggered due time is computed and stored immediately on
        submission, independent of how long the probe takes to run — so a slow
        or hung probe doesn't throw off the schedule for subsequent ticks.
        """
        guid = state.context.guid
        sched = self._schedules[guid]
        key = (guid, channel)
        with self._lock:
            existing = self._inflight.get(key)
            if existing is not None:
                return existing
            if now < sched[channel]:
                return None
            sched[channel] = self._compute_next_due(guid, channel, now)
            future = self._executor.submit(self._run_channel_safe, state, channel, now)
            self._inflight[key] = future
            return future

    def _run_channel_safe(self, state: DriveState, channel: str, now: float) -> None:
        """Run a channel's probe(s), isolating errors so one drive can't disrupt others."""
        guid = state.context.guid
        try:
            with ProbeTimeout(self._probe_timeout):
                if channel == "telemetry":
                    self._run_telemetry(state, now)
                elif channel == "snapshot":
                    self._run_snapshot(state, now)
                elif channel == "vitals":
                    self._run_vitals(state, now)
                elif channel == "traits":
                    self._run_traits(state, now)
        except Exception as e:
            print(f"[collector] {channel} failed for {guid}: {e}", file=sys.stderr)
        finally:
            with self._lock:
                self._inflight.pop((guid, channel), None)

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
        descriptors = []
        for probe in self._scan_probes:
            descriptors.extend(probe.run())
        self._reconcile_descriptors(descriptors, now)

    def _run_telemetry(self, state: DriveState, now: float) -> None:
        """Run the telemetry probe chain for a drive and record signals + heartbeat."""
        snapshot = DriveSnapshot()
        for probe in self._telemetry_probes:
            snapshot = probe.run(snapshot, state.context)
        with self._lock:
            state.snapshot = snapshot

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

    def _run_traits_chain(self, descriptor: DriveDescriptor, base: DriveTraits) -> DriveTraits:
        """Run the traits probe chain against descriptor, merging results onto base.

        If traits_probes lists more than one, each runs independently and results
        are merged field-by-field — last probe's non-None value wins for each field.
        """
        traits = base
        for probe in self._traits_probes:
            traits = _merge_traits(traits, probe.run(descriptor))
        return traits

    def _run_traits(self, state: DriveState, now: float) -> None:
        """Re-run the traits probe chain for an already-known drive and refresh its identity fields.

        Merges onto the drive's existing traits rather than a blank DriveTraits,
        so a probe that transiently returns None for a field (e.g. a momentary
        smartctl failure) doesn't wipe out previously known identity info.
        """
        descriptor = state.attachment.primary_descriptor
        traits = self._run_traits_chain(descriptor, state.traits)

        with self._lock:
            state.traits = traits
            state.context.traits = traits

        db.upsert_drive_record(
            guid=state.context.guid,
            serial=traits.serial,
            model=traits.model,
            capacity_bytes=traits.capacity_bytes,
            drive_type=traits.drive_type.value if traits.drive_type else None,
            first_seen=datetime.now().isoformat(),
        )

    def _run_vitals(self, state: DriveState, now: float) -> None:
        """Run the vitals probe chain for a drive and record a vitals row."""
        vitals = DriveVitals(captured_at=datetime.now())
        for probe in self._vitals_probes:
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
            traits = self._run_traits_chain(d, DriveTraits())
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
                state.attachment.block_device = resolve_block_device(best_traits.serial)
                record = db.get_drive_record(guid)
                state.label = record["label"] if record else None
                self._drive_states[guid] = state
                # Telemetry/snapshot/vitals are due immediately so a newly discovered
                # drive gets a baseline reading in this same tick. Traits were just
                # populated by discovery, so its first refresh is a full interval out.
                self._schedules[guid] = {
                    "telemetry": now,
                    "snapshot": now,
                    "vitals": now,
                    "traits": self._compute_next_due(guid, "traits", now),
                }
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
