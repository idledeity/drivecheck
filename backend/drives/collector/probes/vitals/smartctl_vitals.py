"""
probes.vitals.smartctl_vitals — fallback temperature via smartctl -A.

Lighter than the full `-a` telemetry probe (no logs), used as the vitals
channel's fallback temperature source when hwmon didn't supply one. Deliberately
narrow: only extracts temperature.current. Full SMART-attribute mapping stays
the telemetry channel's job (probes.telemetry.smartctl_telemetry).
"""

from drives.tools import smartctl
from drives.drive_models import DriveState, DriveVitals


def run(vitals: DriveVitals, state: DriveState) -> DriveVitals:
    """Fill in temp/temp_source via `smartctl -A`, if hwmon didn't already provide one."""
    if vitals.temp is not None:
        return vitals

    descriptor = state.context.descriptor
    data = smartctl.attributes_only(descriptor.device_name, descriptor.access_type)
    temp = data.get("temperature", {}).get("current")
    if temp is not None:
        vitals.temp = temp
        vitals.temp_source = "smartctl"
    return vitals


if __name__ == "__main__":
    import uuid
    from datetime import datetime

    from drives.collector.probes.scan.smartctl_scan import run as scan_drives
    from drives.collector.probes.traits.smartctl_traits import run as fetch_traits
    from drives.drive_models import DriveContext

    for descriptor in scan_drives():
        traits = fetch_traits(descriptor)
        context = DriveContext(guid=str(uuid.uuid4()), descriptor=descriptor, traits=traits)
        state = DriveState(context=context, traits=traits)
        vitals = run(DriveVitals(captured_at=datetime.now()), state)
        print(f"{descriptor.info_name}: temp={vitals.temp} source={vitals.temp_source}")
