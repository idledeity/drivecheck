"""
probes.scan.smartctl_scan — default scan probe.

Runs `smartctl --scan` and converts each discovered device into a
DriveDescriptor. One descriptor per device entry; duplicates (e.g. the
same physical drive accessible via two paths) are resolved later by the
collector after the traits probe populates serial numbers.
"""

import logging

from drives.tools import smartctl
from drives.drive_models import DriveDescriptor

logger = logging.getLogger(__name__)


def run() -> list[DriveDescriptor]:
    data = smartctl.scan()
    # Real output always carries the "smartctl" block, even with no drives; {}
    # means the call timed out. Raise so the collector keeps its drive list
    # rather than reading a failed scan as "every drive was removed".
    if "smartctl" not in data:
        raise RuntimeError("smartctl --scan-open returned no output (timed out?)")
    descriptors = []
    for dev in data.get("devices", []):
        descriptors.append(DriveDescriptor(
            device_name=dev["name"],
            access_type=dev["type"],
            info_name=dev["info_name"],
        ))
    logger.debug("scan found %d device(s)", len(descriptors))
    return descriptors
