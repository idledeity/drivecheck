import json
import subprocess


def run_smartctl(*args) -> dict:
    """Invoke smartctl -j with the given args and return parsed JSON.

    smartctl uses exit codes as a bitmask to signal drive-level error conditions
    (see smartctl(8) EXIT STATUS). A non-zero exit does not necessarily mean the
    command failed — bits 0-1 indicate command errors, bits 2-6 indicate drive
    health findings. Callers that need to distinguish these should inspect
    result.returncode; this wrapper does not raise on non-zero exits so that
    partial JSON output (still returned on most error codes) is not lost.
    """
    result = subprocess.run(
        ["sudo", "smartctl", "-j"] + list(args),
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def scan() -> dict:
    """smartctl --scan: discover attached drives."""
    return run_smartctl("--scan")


def info(device_name: str, access_type: str) -> dict:
    """smartctl -i: read static identity fields for a single drive."""
    return run_smartctl("-i", "-d", access_type, device_name)


def attributes_all(device_name: str, access_type: str) -> dict:
    """smartctl -a: read SMART attributes and health status for a single drive."""
    return run_smartctl("-a", "-d", access_type, device_name)


def attributes_only(device_name: str, access_type: str) -> dict:
    """smartctl -A: read SMART attributes only (lighter than -a; no logs)."""
    return run_smartctl("-A", "-d", access_type, device_name)
