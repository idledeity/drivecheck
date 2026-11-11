"""
operations.logged_process — Base class for operations that run one external
program against a drive (dd, badblocks, shred, ...).

The program's stderr is redirected to a per-job log file rather than a pipe:
  1. No SIGPIPE hazard — the `/api/restart` path closes all fds ≥ 3 before
     re-exec'ing, which would kill the program on its next stderr write if
     stderr were a pipe.
  2. The job survives a backend restart. The program runs in its own session,
     keeps writing to the log, and is re-identified afterwards by PID +
     /proc cmdline.

This class owns starting the process, following the log, cancellation, and
restart reattachment. Subclasses supply only what differs per program:

  _configure(context, params)   per-run state, called by run() and reattach()
  _build_command(context, params)  the argv to start
  _on_log_line(line) / _on_log_bytes(chunk)  progress parsing
  _verdict(returncode)          judge a finished run from its whole log
  _finished_in_log()            does the log show the run ended? (reattach)

Reattach outcomes:
  - process still running → resume following the log
  - process gone, log shows how it ended → that verdict (finished during downtime)
  - process gone, nothing conclusive in the log → ReattachFailed (INTERRUPTED)
"""

import logging
import os
import re
import signal
import subprocess
import threading
import time
from abc import abstractmethod
from collections.abc import Callable, Iterator
from pathlib import Path

from drives.drive_models import DriveContext
from operations.operation import OperationBase, OperationCancelled, OperationProgress, ReattachFailed
from system_utils import paths

logger = logging.getLogger(__name__)

# How long to wait between log-file reads when no new bytes are available.
_TAIL_POLL_INTERVAL = 0.5

_LINE_BREAK_RE = re.compile(rb"[\r\n]")


def tail_log(
    path: Path,
    start_offset: int = 0,
    startup_timeout: float | None = None,
    is_alive: Callable[[], bool] | None = None,
) -> Iterator[bytes]:
    """Yield raw byte chunks from a growing log file.

    Polls for new bytes at EOF. Stops once `is_alive()` returns False and the
    file is drained, which covers both normal completion and a vanished
    process. Raises TimeoutError if `startup_timeout` is given and no bytes
    appear (from `start_offset`) before it elapses.
    """
    deadline = time.monotonic() + startup_timeout if startup_timeout is not None else None
    with open(path, "rb") as f:
        f.seek(start_offset)
        while True:
            chunk = f.read(65536)
            if chunk:
                deadline = None  # first bytes received — no longer waiting for startup
                yield chunk
                continue
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError(f"no output after {startup_timeout}s")
            if is_alive is not None and not is_alive():
                # Process is gone; drain anything written between our last read and its exit.
                while final := f.read(65536):
                    yield final
                return
            time.sleep(_TAIL_POLL_INTERVAL)


def is_device_mounted(device: str) -> bool:
    """Return True if any partition of device appears in /proc/mounts."""
    try:
        mounts = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return False
    return any(line.split(" ", 1)[0].startswith(device) for line in mounts)


def process_matches(pid: int, device: str, program: str) -> bool:
    """Return True if PID is alive, is `program`, and was started against `device`."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False  # process is gone
    args = raw.rstrip(b"\x00").split(b"\x00")
    if not args or not args[0]:
        return False
    argv0 = os.path.basename(args[0].decode("utf-8", errors="replace"))
    device_bytes = device.encode()
    return argv0 == program and any(device_bytes in a for a in args)


class LoggedProcessOperation(OperationBase):
    """Runs one external program against a drive, following its stderr log."""

    program: str                        # argv0 basename, used to re-identify the process
    startup_timeout_seconds: float = 30
    startup_hint: str = ""              # appended to the "no output" error

    def __init__(self):
        self._cancel_event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._pid: int | None = None
        self._log_path: Path | None = None
        self._device: str | None = None
        self._percent: float | None = 0.0
        self._message: str | None = "Queued"
        self._line_buf = b""

    @staticmethod
    def supports(context: DriveContext) -> bool:
        descriptor = context.descriptor
        return descriptor.device_name.startswith("/dev/") and "megaraid" not in descriptor.access_type

    # ------------------------------------------------------------------
    # Subclass hooks
    # ------------------------------------------------------------------

    def _configure(self, context: DriveContext, params: dict) -> None:
        """Set per-run state from params (totals for progress/verdict). Called by
        run() and reattach(). May raise RuntimeError to refuse the run."""

    @abstractmethod
    def _build_command(self, context: DriveContext, params: dict) -> list[str]:
        """Return the argv to start. May raise RuntimeError to refuse the run."""

    def _on_log_line(self, line: str) -> None:
        """Handle one stripped, non-empty log line (split on \\r and \\n)."""

    def _on_log_bytes(self, chunk: bytes) -> None:
        """Handle a raw chunk of log output. Default: split it into lines for
        _on_log_line(). Override for output that isn't line-based."""
        buf = self._line_buf + chunk
        parts = _LINE_BREAK_RE.split(buf)
        self._line_buf = parts.pop()
        for part in parts:
            line = part.decode("utf-8", errors="replace").strip()
            if line:
                self._on_log_line(line)

    @abstractmethod
    def _verdict(self, returncode: int | None) -> dict:
        """Judge a finished run from its whole log: return the result dict, or
        raise RuntimeError if it failed. returncode is None when the job was
        reattached (no Popen to wait on), so the log is the only evidence."""

    def _finished_in_log(self) -> bool:
        """True if the log shows how the run ended. Used when a reattach finds the
        process gone. Default: never — the job is marked INTERRUPTED."""
        return False

    def _extra_reattach_data(self) -> dict:
        """Extra state to persist for reattach, beyond pid/log_path/device."""
        return {}

    def _restore_reattach_data(self, reattach_data: dict) -> None:
        """Restore what _extra_reattach_data() saved. May raise ReattachFailed."""

    # ------------------------------------------------------------------
    # Run / reattach
    # ------------------------------------------------------------------

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        self._device = device

        if self.destructive and is_device_mounted(device):
            self._message = "Failed"
            raise RuntimeError(f"{device} is currently mounted — unmount all partitions before running {self.name}")

        try:
            self._configure(context, params)
            cmd = self._build_command(context, params)
        except RuntimeError:
            self._message = "Failed"
            raise

        log_path = self._job_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_path = log_path
        self._message = "Starting"
        logger.info("starting %s on %s: %s", self.name, device, " ".join(cmd))

        with open(log_path, "wb") as log_file:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=log_file,
                bufsize=0,
                start_new_session=True,  # detach from the backend's process group
            )
        self._pid = self._proc.pid
        # Persist reattach data as early as possible after Popen succeeds.
        self._save_reattach()

        if self._cancel_event.is_set():
            self._terminate()

        return self._watch_and_wait(start_offset=0, startup_timeout=self.startup_timeout_seconds)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        try:
            pid = int(reattach_data["pid"])
            log_path = Path(reattach_data["log_path"])
        except (KeyError, TypeError, ValueError) as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

        device = context.descriptor.device_name
        self._device = device
        self._log_path = log_path
        self._configure(context, params)
        self._restore_reattach_data(reattach_data)

        if not process_matches(pid, device, self.program):
            # The process is gone. If it ended while the backend was down, its log says how.
            if self._finished_in_log():
                logger.info("%s on %s finished while the backend was down; reading result from log", self.name, device)
                return self._verdict(None)
            raise ReattachFailed(
                f"{self.program} process (pid {pid}) is no longer running and its log shows no result — "
                "it was stopped before finishing"
            )

        self._pid = pid
        self._message = "Resuming"
        logger.info("reattaching to %s on %s (pid %d)", self.name, device, pid)
        # Follow from the current end of the log so megabytes of old progress
        # aren't replayed; _verdict() still reads the whole file at the end.
        start_offset = log_path.stat().st_size if log_path.exists() else 0
        return self._watch_and_wait(start_offset=start_offset)

    def _watch_and_wait(self, start_offset: int = 0, startup_timeout: float | None = None) -> dict:
        """Follow the log until the process exits, then judge the run."""
        is_alive = (lambda: Path(f"/proc/{self._pid}").exists()) if self._pid is not None else None
        try:
            for chunk in tail_log(self._log_path, start_offset, startup_timeout, is_alive):
                if self._cancel_event.is_set():
                    self._terminate()
                    self._message = "Cancelled"
                    raise OperationCancelled()
                self._on_log_bytes(chunk)
            if self._line_buf:
                self._on_log_bytes(b"\n")  # flush a final unterminated line
        except TimeoutError:
            self._terminate()
            if self._cancel_event.is_set():
                self._message = "Cancelled"
                raise OperationCancelled()
            self._message = "Failed"
            raise RuntimeError(f"{self.program} produced no output after {startup_timeout}s{self.startup_hint}")

        # For a reattached job there is no Popen object to wait() on, so poll /proc.
        returncode = self._proc.wait() if self._proc is not None else self._poll_until_done()

        if self._cancel_event.is_set():
            self._message = "Cancelled"
            raise OperationCancelled()
        return self._verdict(returncode)

    # ------------------------------------------------------------------
    # Process plumbing
    # ------------------------------------------------------------------

    def _poll_until_done(self) -> int | None:
        """Wait for a reattached process to exit. Its exit code isn't recoverable
        without waitpid, so this always returns None."""
        if self._pid is None:
            return None
        while Path(f"/proc/{self._pid}").exists():
            if self._cancel_event.is_set():
                self._terminate()
                return None
            time.sleep(_TAIL_POLL_INTERVAL)
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
        return {"pid": self._pid, "log_path": str(self._log_path), "device": self._device,
                **self._extra_reattach_data()}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
        self._terminate()
