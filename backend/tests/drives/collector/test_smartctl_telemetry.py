"""Signal mapping in the smartctl telemetry probe, against real smartctl output."""

import json
from pathlib import Path

import pytest

from drives.collector.probes.telemetry.smartctl_telemetry import _map_ata

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "smartctl_ata_attributes.json").read_text())


@pytest.mark.parametrize("drive, cycles, power_on_hours", [
    ("exos_x16", 3580, 20582),
    ("hp_mb3000gcvbt", 4, 67066),
])
def test_ata_maps_load_cycle_count(drive, cycles, power_on_hours):
    signals = _map_ata(FIXTURES[drive])
    assert signals.load_unload_cycles == cycles     # attr 193, not 192 (power-off retracts)
    assert signals.power_on_hours == power_on_hours
    assert signals.reallocated == 0 and signals.pending == 0 and signals.crc_errors == 0
    assert signals.smart_passed is True


def test_ata_without_attribute_193_reports_none():
    data = json.loads(json.dumps(FIXTURES["exos_x16"]))
    data["ata_smart_attributes"]["table"] = [e for e in data["ata_smart_attributes"]["table"] if e["id"] != 193]
    assert _map_ata(data).load_unload_cycles is None
