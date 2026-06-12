"""
probes.vitals.sysfs_io — disk IO activity rates from /sys/class/block/<dev>/stat.

Reads the 17-field diskstats line for a resolved block device and computes
rates from the delta against the previous tick's reading (carried on
state.vitals.io_raw). Pure sysfs read, no subprocess — cheap enough for the
high-rate vitals channel.
"""

from pathlib import Path

from models import DriveIOActivity, DriveState, DriveVitals

_SECTOR_SIZE = 512  # bytes; diskstats sector counts are always in 512-byte units


def run(vitals: DriveVitals, state: DriveState) -> DriveVitals:
    """Fill in io from /sys/class/block/<dev>/stat deltas against the previous reading."""
    block_device = state.attachment.block_device
    if block_device is None:
        return vitals

    try:
        fields = Path(f"/sys/class/block/{block_device}/stat").read_text().split()
    except OSError:
        return vitals

    raw = [int(f) for f in fields]
    now = vitals.captured_at.timestamp()
    vitals.io_raw = (now, raw)

    prev = state.vitals.io_raw
    if prev is None:
        return vitals

    prev_at, prev_raw = prev
    elapsed = now - prev_at
    if elapsed <= 0:
        return vitals

    read_ios = raw[0] - prev_raw[0]
    read_sectors = raw[2] - prev_raw[2]
    write_ios = raw[4] - prev_raw[4]
    write_sectors = raw[6] - prev_raw[6]
    io_ticks_ms = raw[9] - prev_raw[9]

    vitals.io = DriveIOActivity(
        read_iops=read_ios / elapsed,
        write_iops=write_ios / elapsed,
        read_bytes_per_sec=(read_sectors * _SECTOR_SIZE) / elapsed,
        write_bytes_per_sec=(write_sectors * _SECTOR_SIZE) / elapsed,
        busy_pct=min(100.0, (io_ticks_ms / 1000) / elapsed * 100),
    )
    return vitals


if __name__ == "__main__":
    import time
    import uuid
    from datetime import datetime

    from probes.scan.smartctl_scan import run as scan_drives
    from probes.traits.smartctl_traits import run as fetch_traits
    from probes.vitals.block_device import run as resolve_block_device
    from models import DriveAttachment, DriveContext

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        device = resolve_block_device(traits.serial)
        print(f"\n{descriptor.info_name} -> {device}")
        if device is None:
            continue
        context = DriveContext(guid=str(uuid.uuid4()), descriptor=descriptor, traits=traits)
        state = DriveState(context=context, traits=traits, attachment=DriveAttachment(block_device=device))
        state.vitals = run(DriveVitals(captured_at=datetime.now()), state)
        time.sleep(1)
        vitals = run(DriveVitals(captured_at=datetime.now()), state)
        print(f"  {vitals.io}")
