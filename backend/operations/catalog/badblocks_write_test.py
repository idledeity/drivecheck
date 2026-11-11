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
  stderr: progress updates, plus "Pass completed, N bad blocks found." at the
          end of each pass — printed only with -v, and the verdict relies on it
  stdout: bad block numbers (one per line); discarded since we parse the count
          from the stderr summary line

Real -w -s -v output (e2fsprogs; \\b-overwritten progress shown as "|"):
    Checking for bad blocks in read-write mode
    From block 0 to 76799
    Testing with pattern 0xaa:   0.00% done, 0:00 elapsed. (0/0/0 errors)| 48.00% done, ...|done
    Reading and comparing:   0.00% done, 0:06 elapsed. (0/0/0 errors)| 50.67% done, ...|done
    ... the same for 0x55, 0xff, 0x00 (8 phases per pass, each 0-100%) ...
    Pass completed, 0 bad blocks found. (0/0/0 errors)
"""

import logging
import re
import shutil
from pathlib import Path

from drives.drive_models import DriveContext
from operations.logged_process import LoggedProcessOperation
from operations.operation import ParamSpec

logger = logging.getLogger(__name__)

# Progress events, in the order badblocks prints them. Each pass has 8 phases
# (write + read/compare for each of 4 patterns) and each phase counts 0-100%.
_PROGRESS_EVENT_RE = re.compile(
    rb"Testing with pattern (?P<pattern>0x[0-9a-fA-F]+):"   # write phase starts
    rb"|(?P<readback>Reading and comparing:)"               # read/compare phase starts
    rb"|(?P<pct>\d+\.\d+)% done"                            # progress within the phase
)
# Matches "Pass completed, N bad blocks found." on stderr at end of each pass
_DONE_RE = re.compile(rb"Pass completed,\s+(\d+) bad block")

_PHASES_PER_PASS = 8  # 4 patterns × (write + read/compare)
# Longest event text; a chunk tail this long may hold an event split across reads.
_EVENT_CARRY_BYTES = 64

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
        self._phases_started = 0
        self._phase_pct = 0.0
        self._phase_label = ""      # e.g. "0x55 write" | "0x55 read-back"
        self._current_pattern: str | None = None
        self._progress_carry = b""

    @classmethod
    def summarize(cls, result: dict) -> str | None:
        passes = result["passes"]
        return f"No bad blocks found in {passes} pass{'es' if passes != 1 else ''}"

    def _configure(self, context: DriveContext, params: dict) -> None:
        self._passes = int(params["passes"])

    def _build_command(self, context: DriveContext, params: dict) -> list[str]:
        return [
            _find_badblocks(),
            "-w",
            "-s",
            "-v",  # required: without it badblocks never prints "Pass completed, N bad blocks found."
            "-b", str(int(params["block_size"])),
            "-c", "1024",
            "-p", str(self._passes),
            context.block_device_path,
        ]

    def _on_log_bytes(self, chunk: bytes) -> None:
        """Track the current phase and its percentage from badblocks' progress output.

        Events are handled in order; the unmatched tail after the last one is
        carried into the next chunk so an event split across reads is seen once.
        """
        buf = self._progress_carry + chunk
        last_end = 0
        for m in _PROGRESS_EVENT_RE.finditer(buf):
            last_end = m.end()
            if m.group("pattern"):
                self._current_pattern = m.group("pattern").decode("ascii")
                self._start_phase("write")
            elif m.group("readback"):
                self._start_phase("read-back")
            else:
                self._phase_pct = float(m.group("pct"))
        self._progress_carry = buf[max(last_end, len(buf) - _EVENT_CARRY_BYTES):]
        if self._phases_started:
            self._update_progress()

    def _start_phase(self, kind: str) -> None:
        self._phases_started += 1
        self._phase_pct = 0.0
        self._phase_label = f"{self._current_pattern or '?'} {kind}"

    def _update_progress(self) -> None:
        phases_done = self._phases_started - 1
        total_phases = self._passes * _PHASES_PER_PASS
        # Capped below 100 until the verdict: badblocks repeats passes after
        # finding bad blocks (-p), so it can run past the requested count.
        self._percent = round(min(99.0, (phases_done * 100 + self._phase_pct) / total_phases), 1)
        current_pass = phases_done // _PHASES_PER_PASS + 1
        pass_label = (
            f"pass {current_pass}/{self._passes}" if current_pass <= self._passes
            else f"pass {current_pass} (repeat after bad blocks)"
        )
        self._message = f"{pass_label} · {self._phase_label} · {self._phase_pct:.1f}%"

    def _restore_reattach_data(self, reattach_data: dict) -> None:
        # Rebuild the progress position from everything logged so far; the base
        # class then follows only what is written after the restart.
        try:
            with open(self._log_path, "rb") as f:
                while chunk := f.read(1 << 20):
                    self._on_log_bytes(chunk)
        except OSError:
            pass

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
