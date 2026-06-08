"""
collector.py — Drive collector.

Discovers drives via the scan probe, runs traits and telemetry probes for
each, and maintains a live registry of DriveState objects keyed by GUID.
Polls on a configurable interval in a background daemon thread.

GUIDs are derived from the drive's serial number (uuid5), so they are stable
across reboots even if device paths change. Drives with no serial fall back
to the device name as the key.
"""

import threading
import time
import uuid

from models import DriveContext, DriveState, DriveTraits, DriveDescriptor
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
        self._thread = threading.Thread(target=self._loop, daemon=True, name="collector")

    def start(self) -> None:
        """Start the background poll loop. Polls immediately on first call."""
        self._thread.start()

    def get_drive_states(self) -> list[DriveState]:
        """Return a snapshot of all current drive states."""
        with self._lock:
            return list(self._drive_states.values())

    def _loop(self) -> None:
        while True:
            self._poll()
            time.sleep(self._poll_interval)

    def _poll(self) -> None:
        descriptors = smartctl_scan.run()

        for descriptor in descriptors:
            traits = smartctl_traits.run(descriptor)
            guid = _assign_guid(traits, descriptor)

            with self._lock:
                if guid not in self._drive_states:
                    context = DriveContext(guid=guid, descriptor=descriptor, traits=traits)
                    self._drive_states[guid] = DriveState(context=context)
                state = self._drive_states[guid]

            telemetry = smartctl_telemetry.run(state.context)

            with self._lock:
                state.traits = traits
                state.snapshot.telemetry = telemetry
