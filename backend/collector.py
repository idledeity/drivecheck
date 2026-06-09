"""
collector.py — Drive collector.

Discovers drives via the scan probe, runs traits and telemetry probes for
each, and maintains a live registry of DriveState objects keyed by GUID.
Polls on a configurable interval in a background daemon thread.

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

import threading
import time
import uuid

from analysis.descriptor_rank import score_descriptor
from models import DriveContext, DriveDescriptor, DriveState, DriveTraits
from probes.scan import smartctl_scan
from probes.traits import smartctl_traits
from probes.telemetry import smartctl_telemetry

_GUID_NAMESPACE = uuid.UUID("d1a3ec4f-8b2a-4c5e-9f7d-6e8a2b1c3d4e")


def _assign_guid(traits: DriveTraits, descriptor: DriveDescriptor) -> str:
    """Return a stable GUID for a drive, keyed on serial number if available."""
    key = traits.serial or descriptor.device_name
    return str(uuid.uuid5(_GUID_NAMESPACE, key))


class Collector:
    def __init__(self, poll_interval: int):
        self._poll_interval = poll_interval
        self._drive_states: dict[str, DriveState] = {}
        self._lock = threading.Lock()
        self._poll_lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="collector")

    def start(self) -> None:
        """Start the background poll loop. Polls immediately on first call."""
        self._thread.start()

    def get_drive_states(self) -> list[DriveState]:
        """Return a snapshot of all current drive states."""
        with self._lock:
            return list(self._drive_states.values())

    def trigger_poll(self) -> None:
        """Run a poll immediately, blocking until complete."""
        self._poll()

    def _loop(self) -> None:
        while True:
            self._poll()
            time.sleep(self._poll_interval)

    def _poll(self) -> None:
        with self._poll_lock:
            self._do_poll()

    def _do_poll(self) -> None:
        descriptors = smartctl_scan.run()
        self._reconcile_descriptors(descriptors)

        # Run telemetry for all active states using each drive's chosen access path
        with self._lock:
            active_states = list(self._drive_states.values())

        for state in active_states:
            telemetry = smartctl_telemetry.run(state.context)
            with self._lock:
                state.snapshot.telemetry = telemetry

    def _reconcile_descriptors(self, descriptors: list[DriveDescriptor]) -> None:
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
            self._discover(unknown, matched_guids)

        self._remove_gone_drives(matched_guids)

    def _discover(self, descriptors: list[DriveDescriptor], matched_guids: set[str]) -> None:
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
            self._register_drive(guid, best_descriptor, best_traits, all_descriptors, matched_guids)

    def _register_drive(
        self,
        guid: str,
        best_descriptor: DriveDescriptor,
        best_traits: DriveTraits,
        all_descriptors: list[DriveDescriptor],
        matched_guids: set[str],
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
                self._drive_states[guid] = state
        matched_guids.add(guid)

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
