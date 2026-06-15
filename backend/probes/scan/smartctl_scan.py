"""
probes.scan.smartctl_scan — default scan probe.

Runs `smartctl --scan` and converts each discovered device into a
DriveDescriptor. One descriptor per device entry; duplicates (e.g. the
same physical drive accessible via two paths) are resolved later by the
collector after the traits probe populates serial numbers.
"""

from drive_tools import smartctl
from drive_models import DriveDescriptor


def run() -> list[DriveDescriptor]:
    data = smartctl.scan()
    descriptors = []
    for dev in data.get("devices", []):
        descriptors.append(DriveDescriptor(
            device_name=dev["name"],
            access_type=dev["type"],
            info_name=dev["info_name"],
        ))
    return descriptors
