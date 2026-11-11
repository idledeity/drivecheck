"""
operations.logged_process — Base class for operations that run one external
program against a drive (dd, badblocks, shred, ...).

The program's stderr is redirected to a per-job log file rather than a pipe:
  1. No SIGPIPE hazard — a restart replaces the backend process, which would
     kill the program on its next stderr write if stderr were a pipe to it.
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

import errno
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

from drives.collector.probes.vitals.block_device import run as resolve_block_device
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


def device_in_use_reason(device: str) -> str | None:
    """Return why device can't be claimed exclusively (a clause to follow the
    device path, e.g. "is in use (...)"), or None if it's free.

    Opening a block device with O_EXCL fails with EBUSY while anything holds
    it: a mounted partition, an md RAID or LVM member, dm-crypt, active swap,
    a ZFS pool, or another exclusive opener. /proc/mounts sees only the first
    of those. The fd is closed straight away; this is a check, not a claim.
    """
    try:
        fd = os.open(device, os.O_RDONLY | os.O_EXCL)
    except OSError as e:
        if e.errno == errno.EBUSY:
            return "is in use (part of a RAID, LVM or ZFS pool, encrypted volume, swap, or held by another program)"
        return f"could not be opened: {e.strerror}"
    os.close(fd)
    return None


def _pid_running(pid: int) -> bool:
    """True if `pid` exists and is not a zombie. For processes that aren't our
    children, whose exit we can't wait() for — a zombie has already exited."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    # Format: "pid (comm) state ..." — comm may contain spaces/parens, so split on the last ")".
    state = stat.rsplit(")", 1)[-1].split()[0]
    return state not in ("Z", "X")


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
        # These programs read and write the kernel block device, not the path
        # smartctl uses (an NVMe controller, or /dev/bus/N behind a MegaRAID HBA).
        return context.block_device is not None

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

        device = context.block_device_path
        self._device = device

        # Kernel names can change between scans (a replug, a reboot). Check the
        # serial still resolves to this device right before touching it.
        current = resolve_block_device(context.traits.serial)
        if device is None or current != context.block_device:
            self._message = "Failed"
            raise RuntimeError(
                f"the block device for serial {context.traits.serial} is now "
                f"{'/dev/' + current if current else 'not found'}, not {device} — "
                "rescan drives and try again"
            )

        if self.destructive and is_device_mounted(device):
            self._message = "Failed"
            raise RuntimeError(f"{device} is currently mounted — unmount all partitions before running {self.name}")
        if self.destructive and (reason := device_in_use_reason(device)):
            self._message = "Failed"
            raise RuntimeError(f"{device} {reason} — refusing to run {self.name}")

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

        device = context.block_device_path
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
        try:
            for chunk in tail_log(self._log_path, start_offset, startup_timeout, self._process_alive):
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

    def _process_alive(self) -> bool:
        """True while the process is still running.

        An exited child stays a zombie (its /proc entry remains) until it is
        reaped, so a process this backend started is checked with Popen.poll(),
        which reaps it. A reattached process was started by a previous backend
        process (restart spawns a fresh process), so it is never our child: it
        is checked via /proc, counting a zombie as exited.
        """
        if self._proc is not None:
            return self._proc.poll() is None
        return self._pid is not None and _pid_running(self._pid)

    def _poll_until_done(self) -> None:
        """Wait for a reattached process to exit. It isn't our child, so its exit
        code can't be recovered — the verdict comes from the log."""
        while self._process_alive():
            if self._cancel_event.is_set():
                self._terminate()
                return
            time.sleep(_TAIL_POLL_INTERVAL)

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
