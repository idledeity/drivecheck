"""
probes.vitals.mount_status — whether a drive's block device is currently mounted.

Reads /proc/mounts directly — cheap enough for the high-rate vitals channel, no
subprocess needed. Sets state.attachment.is_mounted as a side effect; DriveVitals
itself is returned unchanged, since mount status isn't part of the persisted
vitals history.
"""

from pathlib import Path

from drive_models import DriveState, DriveVitals


def run(vitals: DriveVitals, state: DriveState) -> DriveVitals:
    """Set state.attachment.is_mounted by checking /proc/mounts for the block device."""
    block_device = state.attachment.block_device
    if block_device is None:
        state.attachment.is_mounted = False
        return vitals

    try:
        mounts = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return vitals

    prefix = f"/dev/{block_device}"
    state.attachment.is_mounted = any(line.split(" ", 1)[0].startswith(prefix) for line in mounts)
    return vitals


if __name__ == "__main__":
    import uuid
    from datetime import datetime

    from drive_models import DriveAttachment, DriveContext
    from drive_collector.probes.scan.smartctl_scan import run as scan_drives
    from drive_collector.probes.traits.smartctl_traits import run as fetch_traits
    from drive_collector.probes.vitals.block_device import run as resolve_block_device

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        device = resolve_block_device(traits.serial)
        context = DriveContext(guid=str(uuid.uuid4()), descriptor=descriptor, traits=traits)
        state = DriveState(context=context, traits=traits, attachment=DriveAttachment(block_device=device))
        run(DriveVitals(captured_at=datetime.now()), state)
        print(f"{descriptor.info_name} -> {device}: is_mounted={state.attachment.is_mounted}")
