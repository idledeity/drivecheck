import json
import subprocess
from enum import Enum

from drive_tools.timeout import get_timeout


class SelfTestType(Enum):
    """Self-test mode passed to `smartctl -t`."""
    SHORT = "short"
    LONG = "long"


def run_smartctl(*args) -> dict:
    """Invoke smartctl -j with the given args and return parsed JSON.

    smartctl uses exit codes as a bitmask to signal drive-level error conditions
    (see smartctl(8) EXIT STATUS). A non-zero exit does not necessarily mean the
    command failed — bits 0-1 indicate command errors, bits 2-6 indicate drive
    health findings. Callers that need to distinguish these should inspect
    result.returncode; this wrapper does not raise on non-zero exits so that
    partial JSON output (still returned on most error codes) is not lost.

    Subject to the ambient timeout set by drive_tools.timeout.ProbeTimeout. If
    exceeded, returns {} — callers read fields via .get() with defaults, so a
    timed-out probe degrades to "unknown" rather than raising.
    """
    try:
        result = subprocess.run(
            ["sudo", "-n", "smartctl", "-j"] + list(args),
            capture_output=True,
            text=True,
            timeout=get_timeout(),
        )
    except subprocess.TimeoutExpired:
        return {}
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


def self_test_start(device_name: str, access_type: str, test_type: SelfTestType) -> dict:
    """smartctl -t <test_type>: start a SMART self-test."""
    return run_smartctl("-t", test_type.value, "-d", access_type, device_name)


def self_test_abort(device_name: str, access_type: str) -> dict:
    """smartctl -X: abort whatever SMART self-test is currently running on the drive."""
    return run_smartctl("-X", "-d", access_type, device_name)
