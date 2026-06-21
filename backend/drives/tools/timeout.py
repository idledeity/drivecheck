"""
drives.tools.timeout — ambient per-thread subprocess timeout.

Probes call drives.tools wrappers (smartctl, lsblk, ...) without knowing
anything about collector.probe_timeout. The collector sets the timeout for
the duration of a channel's probe chain via ProbeTimeout; drives.tools
wrappers read it via get_timeout() when invoking subprocess.run. Each
channel's probe chain runs synchronously on a single thread, so thread-local
state set at the start of that chain is visible to every subprocess call made
within it.
"""

import threading

_local = threading.local()


class ProbeTimeout:
    """Context manager: set the ambient subprocess timeout for the current thread."""

    def __init__(self, seconds: float):
        self._seconds = seconds

    def __enter__(self) -> "ProbeTimeout":
        self._previous = getattr(_local, "seconds", None)
        _local.seconds = self._seconds
        return self

    def __exit__(self, *exc_info) -> None:
        _local.seconds = self._previous


def get_timeout() -> float | None:
    """Return the current thread's ambient subprocess timeout, or None if unset."""
    return getattr(_local, "seconds", None)
