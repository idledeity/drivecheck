"""
operations.catalog.dd_common — Shared base for the dd read and write tests.

dd's `status=progress` output uses carriage returns (\\r) to overwrite lines in
a terminal; redirected to the job log those bytes are simply appended, so the
log grows by about one progress line per second.

A run that ends normally — or is interrupted by SIGINT — prints a summary:
    5723166+1 records in
    5723166+1 records out
    6001175126016 bytes (6.0 TB, 5.5 TiB) copied, 34786.1 s, 173 MB/s
A killed process prints nothing, and every error is a "dd: ..." line. The
verdict is taken from that summary, the error lines, and the expected size.

DDOperation leaves _build_command abstract, so operation discovery skips it.
"""

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from drives.drive_models import DriveContext
from operations.logged_process import LoggedProcessOperation

logger = logging.getLogger(__name__)

_PROGRESS_RE = re.compile(r"^(\d+) bytes")
_RECORDS_OUT_RE = re.compile(r"^\d+\+\d+ records out$")


def _expected_bytes(block_size: int, count: int, skip: int, capacity: int | None) -> int | None:
    """Bytes a dd run should copy: `count` blocks (clipped to the device end), or
    everything from the skip offset to the end. None if it can't be known."""
    remaining = max(0, capacity - skip * block_size) if capacity else None
    if count > 0:
        requested = count * block_size
        return min(requested, remaining) if remaining is not None else requested
    return remaining


@dataclass
class DDOutcome:
    """What dd's log says about how the run ended."""
    completed: bool             # dd printed its final records/bytes summary
    bytes_copied: int | None    # from the final summary (None if not completed)
    errors: list[str]           # "dd: ..." error lines, in order

    @classmethod
    def from_log(cls, path: Path) -> "DDOutcome":
        """Parse a whole dd log file for its final summary and any error lines.

        The final summary is a "N+M records out" line followed by "N bytes ... copied".
        Progress lines look like the bytes line too, so only one that follows the
        last "records out" counts. A process that was killed never prints it.
        """
        try:
            text = path.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            return cls(completed=False, bytes_copied=None, errors=[])
        lines = [ln.strip() for ln in re.split(r"[\r\n]", text) if ln.strip()]
        errors = [ln for ln in lines if ln.startswith("dd: ") and not ln.startswith("dd: warning")]
        last_out = max((i for i, ln in enumerate(lines) if _RECORDS_OUT_RE.match(ln)), default=None)
        if last_out is not None:
            for ln in lines[last_out + 1:]:
                match = _PROGRESS_RE.match(ln)
                if match:
                    return cls(completed=True, bytes_copied=int(match.group(1)), errors=errors)
        return cls(completed=False, bytes_copied=None, errors=errors)

    def failure(self, returncode: int | None, expected_bytes: int | None) -> str | None:
        """Return why this finished run did not pass, or None if it passed.

        returncode is None when the job was reattached after a restart (no Popen
        to wait on) — then the log is the only evidence, so a missing summary fails.
        """
        if self.errors:
            more = f" (+{len(self.errors) - 1} more)" if len(self.errors) > 1 else ""
            return self.errors[0] + more
        if returncode not in (0, None):
            return f"dd exited with code {returncode}"
        if not self.completed:
            return "dd exited without printing its final summary — the run did not finish (process killed?)"
        if expected_bytes is not None and self.bytes_copied != expected_bytes:
            return f"dd stopped early: {self.bytes_copied} of {expected_bytes} bytes copied"
        return None


class DDOperation(LoggedProcessOperation):
    """Shared progress, reattach and verdict logic for the dd read/write tests."""

    category = "Scan"
    tool = "dd"
    program = "dd"
    # dd's status=progress timer fires ~once/second once it's actually running.
    # A longer silence means dd never started (e.g. sudo stuck on a password
    # prompt, bad device path, permission denied).
    startup_timeout_seconds = 15
    startup_hint = " (it may be stuck waiting for a sudo password prompt)"

    result_key: str     # "bytes_read" | "bytes_written"
    verb: str           # "read" | "written", for the log line

    def __init__(self):
        super().__init__()
        self._block_size = 0
        self._total_bytes: int | None = None

    def _configure(self, context: DriveContext, params: dict) -> None:
        self._block_size = int(params["block_size"])
        self._total_bytes = _expected_bytes(
            self._block_size, int(params["count"]), int(params["skip"]), context.traits.capacity_bytes
        )

    def _on_log_line(self, line: str) -> None:
        match = _PROGRESS_RE.match(line)
        if match:
            copied = int(match.group(1))
            if self._total_bytes:
                self._percent = min(100.0, round(copied / self._total_bytes * 100, 1))
            self._message = line

    def _finished_in_log(self) -> bool:
        outcome = DDOutcome.from_log(self._log_path)
        return outcome.completed or bool(outcome.errors)

    def _verdict(self, returncode: int | None) -> dict:
        outcome = DDOutcome.from_log(self._log_path)
        failure = outcome.failure(returncode, self._total_bytes)
        if failure:
            self._message = "Failed"
            raise RuntimeError(failure)
        copied = outcome.bytes_copied or 0

        self._percent = 100.0
        self._message = "Done"
        logger.info("%s on %s completed: %d bytes %s", self.name, self._device, copied, self.verb)
        return {self.result_key: copied, "device": self._device, "block_size": self._block_size}
