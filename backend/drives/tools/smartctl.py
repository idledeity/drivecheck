import json
import logging
import subprocess
from dataclasses import dataclass
from enum import Enum

from drives.tools.timeout import get_timeout

logger = logging.getLogger(__name__)


class SelfTestType(Enum):
    """Self-test mode passed to `smartctl -t`."""
    SHORT = "short"
    LONG = "long"


@dataclass
class SmartctlResult:
    """Result of a smartctl action command (start/abort self-test) run without -j."""
    success: bool
    message: str  # smartctl's own text output, version/copyright banner stripped


def run_smartctl(*args) -> dict:
    """Invoke smartctl -j with the given args and return parsed JSON.

    smartctl uses exit codes as a bitmask to signal drive-level error conditions
    (see smartctl(8) EXIT STATUS). A non-zero exit does not necessarily mean the
    command failed — bits 0-1 indicate command errors, bits 2-6 indicate drive
    health findings. Callers that need to distinguish these should inspect
    result.returncode; this wrapper does not raise on non-zero exits so that
    partial JSON output (still returned on most error codes) is not lost.

    Subject to the ambient timeout set by drives.tools.timeout.ProbeTimeout. If
    exceeded, returns {} — callers read fields via .get() with defaults, so a
    timed-out probe degrades to "unknown" rather than raising.
    """
    logger.debug("smartctl -j %s", " ".join(args))
    try:
        result = subprocess.run(
            ["sudo", "-n", "smartctl", "-j"] + list(args),
            capture_output=True,
            text=True,
            timeout=get_timeout(),
        )
    except subprocess.TimeoutExpired:
        logger.warning("smartctl timed out: %s", " ".join(args))
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


def _run_smartctl_action(*args) -> SmartctlResult:
    """Invoke smartctl without -j and return success plus cleaned human-readable output.

    Action commands like -t/-X sometimes explain a pre-flight failure (e.g.
    refusing to start a test while one's already running) only as plain text on
    stdout — that explanation is entirely absent from -j output (confirmed: -j
    gives exit_status=-1 with no "messages" at all for that case). So unlike
    run_smartctl(), these calls skip JSON and surface smartctl's real message.
    """
    logger.debug("smartctl %s", " ".join(args))
    try:
        result = subprocess.run(
            ["sudo", "-n", "smartctl"] + list(args),
            capture_output=True,
            text=True,
            timeout=get_timeout(),
        )
    except subprocess.TimeoutExpired:
        logger.warning("smartctl timed out: %s", " ".join(args))
        return SmartctlResult(success=False, message="smartctl timed out")

    lines = [
        line.strip() for line in result.stdout.splitlines()
        if line.strip() and not line.startswith("smartctl ") and not line.startswith("Copyright")
    ]
    success = result.returncode == 0
    message = " ".join(lines)
    if not success:
        logger.warning("smartctl action failed (exit %d): %s", result.returncode, message)
    return SmartctlResult(success=success, message=message)


def self_test_start(device_name: str, access_type: str, test_type: SelfTestType) -> SmartctlResult:
    """smartctl -t <test_type>: start a SMART self-test."""
    logger.info("starting %s self-test on %s", test_type.value, device_name)
    return _run_smartctl_action("-t", test_type.value, "-d", access_type, device_name)


def self_test_abort(device_name: str, access_type: str) -> SmartctlResult:
    """smartctl -X: abort whatever SMART self-test is currently running on the drive."""
    logger.info("aborting self-test on %s", device_name)
    return _run_smartctl_action("-X", "-d", access_type, device_name)
