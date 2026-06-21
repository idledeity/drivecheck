"""
probes.vitals.hwmon_temp — best-effort drive temperature via hwmon/drivetemp.

Reads /sys/block/<dev>/device/hwmon*/temp1_* if the drivetemp kernel driver
has bound to the device. drivetemp only supports SATA-behind-SAT and NVMe
(see Documentation/hwmon/drivetemp.rst) — native SAS drives never get a
hwmon entry here, so this probe is a no-op on SAS-only systems. Kept as
defensive future-proofing for SATA/NVMe drives.
"""

import glob
from pathlib import Path

from drives.drive_models import DriveState, DriveVitals


def run(vitals: DriveVitals, state: DriveState) -> DriveVitals:
    """Fill in temp/temp_source/extras from hwmon, if drivetemp has bound to this device."""
    block_device = state.attachment.block_device
    if block_device is None:
        return vitals

    temp_files = glob.glob(f"/sys/block/{block_device}/device/hwmon*/**/temp1_*", recursive=True)
    if not temp_files:
        return vitals

    temp = None
    extras = {}
    for temp_file in sorted(temp_files):
        try:
            millidegrees = int(Path(temp_file).read_text().strip())
        except (OSError, ValueError):
            continue
        celsius = round(millidegrees / 1000)

        suffix = Path(temp_file).name.removeprefix("temp1_")
        if suffix == "input":
            temp = celsius
        else:
            extras[suffix] = celsius

    if temp is not None:
        vitals.temp = temp
        vitals.temp_source = "hwmon"
        vitals.extras = extras
    return vitals


if __name__ == "__main__":
    import uuid
    from datetime import datetime

    from drives.collector.probes.scan.smartctl_scan import run as scan_drives
    from drives.collector.probes.traits.smartctl_traits import run as fetch_traits
    from drives.collector.probes.vitals.block_device import run as resolve_block_device
    from drives.drive_models import DriveAttachment, DriveContext

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        device = resolve_block_device(traits.serial)
        context = DriveContext(guid=str(uuid.uuid4()), descriptor=descriptor, traits=traits)
        state = DriveState(context=context, traits=traits, attachment=DriveAttachment(block_device=device))
        vitals = run(DriveVitals(captured_at=datetime.now()), state)
        print(f"{descriptor.info_name} -> {device}: temp={vitals.temp} source={vitals.temp_source} extras={vitals.extras}")
