"""
operations.catalog.badblocks_write_test — destructive bad-block scan using badblocks -w.

Writes a series of test patterns to every block of the device and reads them
back, flagging any that don't match. This is the definitive test for bad
sectors that a read-only scan cannot find. Process handling and restart
reattachment live in LoggedProcessOperation (operations.logged_process).

THIS OPERATION DESTROYS ALL DATA ON THE TARGET DEVICE. It refuses to run if any
partition of the device is currently mounted, checked via /proc/mounts at startup.

badblocks updates progress using backspace characters (\\b) to overwrite the
percentage in-place on the same stderr line — no \\r or \\n between updates until
the pattern completes — so progress is parsed from the raw bytes rather than
from lines.

Output routing:
  stderr: progress updates and "Pass completed, N bad blocks found." summary
  stdout: bad block numbers (one per line); discarded since we parse the count
          from the stderr summary line
"""

import logging
import re
import shutil
from pathlib import Path

from drives.drive_models import DriveContext
from operations.logged_process import LoggedProcessOperation
from operations.operation import ParamSpec, ReattachFailed

logger = logging.getLogger(__name__)

# Matches "X.XX% done" anywhere in the raw byte buffer (including amid \b sequences)
_PERCENT_RE = re.compile(rb"(\d+\.\d+)% done")
# Matches the current pattern name, e.g. "Testing with pattern 0xaa:"
_PATTERN_RE = re.compile(rb"Testing with pattern (0x[0-9a-fA-F]+):")
# Matches "Pass completed, N bad blocks found." on stderr at end of each pass
_DONE_RE = re.compile(rb"Pass completed,\s+(\d+) bad block")

_PATTERNS_PER_PASS = 4  # badblocks -w cycles through 4 patterns per pass

_SBIN_PATH = "/usr/sbin:/usr/local/sbin:/sbin"


def _find_badblocks() -> str:
    """Locate the badblocks binary, checking PATH then common sbin locations."""
    found = shutil.which("badblocks") or shutil.which("badblocks", path=_SBIN_PATH)
    if not found:
        raise RuntimeError(
            "badblocks not found — install e2fsprogs (e.g. apt install e2fsprogs)"
        )
    return found


def _read_badblocks_outcome(path: Path) -> tuple[int, int]:
    """Scan a whole badblocks log; return (passes completed, bad blocks found).

    Each finished pass prints "Pass completed, N bad blocks found." where N is
    the blocks newly found in that pass, so they are summed. The log can be
    tens of MB (backspace progress for days), so it is streamed: each chunk is
    searched together with a short tail of the previous one, starting after the
    last match so a line split across chunks is found exactly once.
    """
    passes = 0
    bad_blocks = 0
    carry = b""
    try:
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                buf = carry + chunk
                last_end = 0
                for m in _DONE_RE.finditer(buf):
                    passes += 1
                    bad_blocks += int(m.group(1))
                    last_end = m.end()
                carry = buf[max(last_end, len(buf) - 256):]
    except OSError:
        pass
    return passes, bad_blocks


class BadblocksWriteTestOperation(LoggedProcessOperation):
    name = "Bad Block Scan (badblocks)"
    category = "Scan"
    tool = "badblocks"
    program = "badblocks"
    destructive = True
    params = [
        ParamSpec(name="block_size", label="Block size (bytes)",  type="number",  default=4096, min=512, max=65536),
        ParamSpec(name="passes",     label="Write/read passes",   type="number",  default=1, min=1, max=4),
    ]

    def __init__(self):
        super().__init__()
        self._passes = 1
        self._patterns_done = 0
        self._total_patterns = _PATTERNS_PER_PASS
        self._current_pattern: str | None = None
        self._progress_buf = b""

    def _configure(self, context: DriveContext, params: dict) -> None:
        self._passes = int(params["passes"])
        self._total_patterns = self._passes * _PATTERNS_PER_PASS

    def _build_command(self, context: DriveContext, params: dict) -> list[str]:
        return [
            _find_badblocks(),
            "-w",
            "-s",
            "-b", str(int(params["block_size"])),
            "-c", "1024",
            "-p", str(self._passes),
            context.descriptor.device_name,
        ]

    def _on_log_bytes(self, chunk: bytes) -> None:
        buf = self._progress_buf + chunk

        for m in _PATTERN_RE.finditer(buf):
            self._current_pattern = m.group(1).decode("ascii")

        last_pct = None
        for m in _PERCENT_RE.finditer(buf):
            last_pct = float(m.group(1))
        if last_pct is not None:
            global_pct = (self._patterns_done * 100 + last_pct) / self._total_patterns
            self._percent = round(global_pct, 1)
            pattern_label = f"pattern {self._current_pattern}: " if self._current_pattern else ""
            self._message = f"{pattern_label}{last_pct:.2f}% done"

        m = _DONE_RE.search(buf)
        if m:
            self._patterns_done += _PATTERNS_PER_PASS
            self._save_reattach()
            buf = buf[m.end():]
        elif len(buf) > 16384:
            buf = buf[-8192:]
        self._progress_buf = buf

    def _extra_reattach_data(self) -> dict:
        return {"patterns_done": self._patterns_done}

    def _restore_reattach_data(self, reattach_data: dict) -> None:
        try:
            self._patterns_done = int(reattach_data.get("patterns_done", 0))
        except (TypeError, ValueError) as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

    def _finished_in_log(self) -> bool:
        # Finished all requested passes, or got far enough to report bad blocks
        # (real evidence about the drive even if it was killed afterwards).
        passes_done, bad_blocks = _read_badblocks_outcome(self._log_path)
        return passes_done >= self._passes or bad_blocks > 0

    def _verdict(self, returncode: int | None) -> dict:
        device = self._device
        passes = self._passes
        passes_done, bad_blocks = _read_badblocks_outcome(self._log_path)
        if returncode not in (0, 1, None):
            self._message = "Failed"
            raise RuntimeError(f"badblocks exited with code {returncode}")

        self._percent = 100.0
        if bad_blocks == 0 and passes_done < passes:
            self._message = "Failed"
            raise RuntimeError(
                f"badblocks exited after {passes_done} of {passes} pass(es) — "
                "the run did not finish (process killed?)"
            )
        if bad_blocks > 0:
            self._message = f"Done — {bad_blocks} bad block(s) found"
            logger.warning("badblocks write test on %s: %d bad block(s) found", device, bad_blocks)
            raise RuntimeError(f"{bad_blocks} bad block(s) found on {device}")

        self._message = "Done"
        logger.info("badblocks write test on %s: no bad blocks found", device)
        return {"device": device, "bad_blocks": 0, "passes": passes}
