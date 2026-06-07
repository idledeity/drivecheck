import subprocess

from flask import json

def scan_drives():
    """Run smartctl --scan and return list of device paths."""
    result = subprocess.run(
        ["sudo", "smartctl", "--scan", "--json"],
        capture_output=True, text=True
    )
    data = json.loads(result.stdout)
    return [dev["name"] for dev in data.get("devices", [])]


def get_serial(device_path):
    """Run smartctl -i on a device and extract serial number."""
    result = subprocess.run(
        ["sudo", "smartctl", "-i", "--json", device_path],
        capture_output=True, text=True
    )
    try:
        data = json.loads(result.stdout)
        return data.get("serial_number", "unknown")
    except json.JSONDecodeError:
        return "unknown"