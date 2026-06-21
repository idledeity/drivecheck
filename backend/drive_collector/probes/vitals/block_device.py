"""
probes.vitals.block_device — resolve a drive's underlying block device name.

Descriptors like "/dev/bus/1" + "megaraid,0" don't map directly to
/sys/class/block/<dev>. This probe matches traits.serial against
`lsblk -J -o NAME,SERIAL -d` to find the corresponding block device
(e.g. "sdb"), which the other vitals probes use for sysfs lookups.
Resolved once per drive at discovery time.
"""

import json
import subprocess

from drive_tools.timeout import get_timeout


def run(serial: str | None) -> str | None:
    """Return the block device name (e.g. "sdb") whose serial matches, or None."""
    if not serial:
        return None

    try:
        result = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,SERIAL", "-d"],
            capture_output=True,
            text=True,
            timeout=get_timeout(),
        )
    except subprocess.TimeoutExpired:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    for device in data.get("blockdevices", []):
        if device.get("serial") == serial:
            return device.get("name")
    return None


if __name__ == "__main__":
    from drive_collector.probes.scan.smartctl_scan import run as scan_drives
    from drive_collector.probes.traits.smartctl_traits import run as fetch_traits

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        block_device = run(traits.serial)
        print(f"{descriptor.info_name}: serial={traits.serial} -> block_device={block_device}")
