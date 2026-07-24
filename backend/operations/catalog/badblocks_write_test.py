"""
operations.catalog.badblocks_write_test — destructive bad-block scan using badblocks -w.

Writes a series of test patterns to every block of the device and reads them
back, flagging any that don't match. This is the definitive test for bad
sectors that a read-only scan cannot find.

THIS OPERATION DESTROYS ALL DATA ON THE TARGET DEVICE. It refuses to run if any
partition of the device is currently mounted, checked via /proc/mounts at startup.

badblocks updates progress using backspace characters (\b) to overwrite the
percentage in-place on the same stderr line — no \r or \n between updates until
the pattern completes. Progress is tracked by scanning the raw byte buffer for
the latest "X.XX% done" value.

stderr is redirected to a log file (not a pipe) so the job survives a backend
restart: the running badblocks process can be re-identified by PID + /proc cmdline
and monitoring resumes by tailing the log file.

Output routing:
  stderr: progress updates and "Pass completed, N bad blocks found." summary
  stdout: bad block numbers (one per line); discarded since we parse the count
          from the stderr summary line
"""

import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from operations.operation import OperationBase, OperationCancelled, OperationProgress, ParamSpec, ReattachFailed
from drives.drive_models import DriveContext
from system_utils import paths

logger = logging.getLogger(__name__)

# Matches "X.XX% done" anywhere in the raw byte buffer (including amid \b sequences)
_PERCENT_RE = re.compile(rb"(\d+\.\d+)% done")
# Matches the current pattern name, e.g. "Testing with pattern 0xaa:"
_PATTERN_RE = re.compile(rb"Testing with pattern (0x[0-9a-fA-F]+):")
# Matches "Pass completed, N bad blocks found." on stderr at end of each pass
_DONE_RE = re.compile(rb"Pass completed,\s+(\d+) bad block")

_STARTUP_TIMEOUT_SECONDS = 30
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


def _is_device_mounted(device: str) -> bool:
    """Return True if any partition of device appears in /proc/mounts."""
    try:
        mounts = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return False
    return any(line.split(" ", 1)[0].startswith(device) for line in mounts)


def _pid_matches(pid: int, device: str) -> bool:
    """Return True if PID is alive and its cmdline looks like our badblocks invocation."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False
    args = raw.rstrip(b"\x00").split(b"\x00")
    if not args:
        return False
    argv0 = os.path.basename(args[0].decode("utf-8", errors="replace"))
    device_bytes = device.encode()
    return argv0 == "badblocks" and any(device_bytes in a for a in args)


def _iter_raw_chunks(
    path: Path,
    start_offset: int = 0,
    startup_timeout: float | None = None,
    is_alive=None,
):
    """Yield raw byte chunks from a growing log file.

    Polls for new bytes when the file appears to be at EOF. Stops when
    is_alive() returns False and there is no more data. Raises TimeoutError
    if startup_timeout is given and no bytes appear before it elapses.
    """
    deadline = time.monotonic() + startup_timeout if startup_timeout is not None else None
    with open(path, "rb") as f:
        f.seek(start_offset)
        while True:
            chunk = f.read(65536)
            if not chunk:
                if deadline is not None and time.monotonic() > deadline:
                    raise TimeoutError(f"badblocks produced no output after {startup_timeout}s")
                if is_alive is not None and not is_alive():
                    final = f.read(65536)
                    if final:
                        yield final
                    break
                time.sleep(0.5)
                continue
            deadline = None
            yield chunk


class BadblocksWriteTestOperation(OperationBase):
    name = "Bad Block Scan (badblocks)"
    category = "Scan"
    tool = "badblocks"
    destructive = True
    params = [
        ParamSpec(name="block_size", label="Block size (bytes)",  type="number",  default=4096, min=512, max=65536),
        ParamSpec(name="passes",     label="Write/read passes",   type="number",  default=1, min=1, max=4),
    ]

    def __init__(self):
        self._cancel_event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._pid: int | None = None
        self._log_path: Path | None = None
        self._device: str | None = None
        self._percent: float | None = 0.0
        self._message: str | None = "Queued"
        self._patterns_done = 0
        self._total_patterns = _PATTERNS_PER_PASS
        self._current_pattern: str | None = None

    @staticmethod
    def supports(context: DriveContext) -> bool:
        descriptor = context.descriptor
        return descriptor.device_name.startswith("/dev/") and "megaraid" not in descriptor.access_type

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        block_size = int(params["block_size"])
        passes = int(params["passes"])
        self._total_patterns = passes * _PATTERNS_PER_PASS

        if _is_device_mounted(device):
            self._message = "Failed"
            raise RuntimeError(
                f"{device} is currently mounted — unmount all partitions before running a bad block scan"
            )

        cmd = [
            _find_badblocks(),
            "-w",
            "-s",
            "-b", str(block_size),
            "-c", "1024",
            "-p", str(passes),
            device,
        ]

        log_path = self._job_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)

        self._device = device
        self._log_path = log_path
        self._message = "Starting"
        logger.info("starting badblocks write test on %s: %s", device, " ".join(cmd))

        with open(log_path, "wb") as log_file:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=log_file,
                bufsize=0,
                start_new_session=True,
            )
        self._pid = self._proc.pid
        self._save_reattach()

        if self._cancel_event.is_set():
            self._terminate()

        return self._watch_and_wait(passes, start_offset=0, startup_timeout=_STARTUP_TIMEOUT_SECONDS)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        try:
            pid = int(reattach_data["pid"])
            log_path = Path(reattach_data["log_path"])
            patterns_done = int(reattach_data.get("patterns_done", 0))
        except (KeyError, TypeError, ValueError) as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

        device = context.descriptor.device_name
        if not _pid_matches(pid, device):
            raise ReattachFailed(
                f"badblocks process (pid {pid}) is no longer running or no longer matches device {device}"
            )

        passes = int(params["passes"])
        self._pid = pid
        self._device = device
        self._log_path = log_path
        self._patterns_done = patterns_done
        self._total_patterns = passes * _PATTERNS_PER_PASS
        self._message = "Resuming"
        logger.info("reattaching to badblocks write test on %s (pid %d)", device, pid)

        start_offset = log_path.stat().st_size if log_path.exists() else 0
        return self._watch_and_wait(passes, start_offset=start_offset)

    def _watch_and_wait(self, passes: int, start_offset: int = 0, startup_timeout: float | None = None) -> dict:
        device = self._device
        bad_blocks = 0
        buf = b""
        is_alive = (lambda: Path(f"/proc/{self._pid}").exists()) if self._pid is not None else None

        try:
            for chunk in _iter_raw_chunks(
                self._log_path,
                start_offset=start_offset,
                startup_timeout=startup_timeout,
                is_alive=is_alive,
            ):
                if self._cancel_event.is_set():
                    self._terminate()
                    self._message = "Cancelled"
                    raise OperationCancelled()

                buf += chunk

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
                    bad_blocks += int(m.group(1))
                    self._patterns_done += _PATTERNS_PER_PASS
                    self._save_reattach()
                    buf = buf[m.end():]
                    continue

                if len(buf) > 16384:
                    buf = buf[-8192:]

        except TimeoutError:
            self._terminate()
            if self._cancel_event.is_set():
                self._message = "Cancelled"
                raise OperationCancelled()
            self._message = "Failed"
            raise RuntimeError(f"badblocks produced no output after {_STARTUP_TIMEOUT_SECONDS}s")

        if self._proc is not None:
            returncode = self._proc.wait()
        else:
            returncode = self._poll_until_done()

        if self._cancel_event.is_set():
            self._message = "Cancelled"
            raise OperationCancelled()
        if returncode not in (0, 1, None):
            self._message = "Failed"
            raise RuntimeError(f"badblocks exited with code {returncode}")

        self._percent = 100.0
        if bad_blocks > 0:
            self._message = f"Done — {bad_blocks} bad block(s) found"
            logger.warning("badblocks write test on %s: %d bad block(s) found", device, bad_blocks)
            raise RuntimeError(f"{bad_blocks} bad block(s) found on {device}")

        self._message = "Done"
        logger.info("badblocks write test on %s: no bad blocks found", device)
        return {"device": device, "bad_blocks": 0, "passes": passes}

    def _poll_until_done(self) -> int | None:
        if self._pid is None:
            return None
        while Path(f"/proc/{self._pid}").exists():
            if self._cancel_event.is_set():
                self._terminate()
                return None
            time.sleep(0.5)
        return None

    def _terminate(self) -> None:
        if self._proc is not None:
            self._proc.terminate()
        elif self._pid is not None:
            try:
                os.kill(self._pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def _job_log_path(self) -> Path:
        job_id = getattr(self, "_job_id", None) or "unknown"
        return paths.data_dir() / "job_logs" / f"{job_id}.log"

    def get_reattach_data(self) -> dict | None:
        if self._pid is None:
            return None
        return {
            "pid": self._pid,
            "log_path": str(self._log_path),
            "device": self._device,
            "patterns_done": self._patterns_done,
        }

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
        self._terminate()
