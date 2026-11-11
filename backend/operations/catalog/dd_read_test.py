"""
operations.catalog.dd_read_test — sequential full-disk read test using dd.

Reads every byte of the target device with `dd ... of=/dev/null`, exercising
the drive without writing to it.

dd's progress output (`status=progress`) is redirected to a file rather than
piped back to the Python process.  This has two benefits:
  1. It eliminates a SIGPIPE hazard: the `/api/restart` path closes all fds ≥ 3
     before re-exec'ing, which would kill dd the moment it wrote its next
     progress line if stderr were a pipe.
  2. It makes the job reattachable after a restart — the log file persists and
     the running dd process can be re-identified by PID + /proc cmdline.

dd's `status=progress` uses carriage returns (\\r) to overwrite lines in a
terminal.  When redirected to a regular file those \\r bytes are simply
appended, so the file grows at ~one line per second for the duration of
the test.  The tailing reader handles this transparently.
"""

import logging
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from operations.operation import OperationBase, OperationCancelled, OperationProgress, ParamSpec, ReattachFailed
from drives.drive_models import DriveContext
from system_utils import paths

logger = logging.getLogger(__name__)

_PROGRESS_RE = re.compile(r"^(\d+) bytes")

# dd's status=progress timer fires ~once/second once it's actually running.
# A longer silence means dd never started (e.g. sudo stuck on a password
# prompt, bad device path, permission denied).
_STARTUP_TIMEOUT_SECONDS = 15

# How long to wait between log-file poll attempts when no new bytes are available.
_TAIL_POLL_INTERVAL = 0.5


def _iter_log_lines(
    path: Path,
    start_offset: int = 0,
    startup_timeout: float | None = None,
    is_alive: Callable[[], bool] | None = None,
):
    """Yield decoded lines from a growing log file, splitting on '\\r' and '\\n'.

    Polls the file for new bytes when it appears to be at EOF.  Stops when
    `is_alive()` returns False and there is no more data — which covers both
    normal completion and process-gone scenarios without requiring the caller
    to break out of the for loop manually.

    Raises TimeoutError if startup_timeout is given and no bytes have appeared
    in the file (from start_offset) before that many seconds elapse.
    """
    buf = b""
    deadline = time.monotonic() + startup_timeout if startup_timeout is not None else None

    with open(path, "rb") as f:
        f.seek(start_offset)
        while True:
            chunk = f.read(65536)
            if not chunk:
                if deadline is not None and time.monotonic() > deadline:
                    raise TimeoutError(f"dd produced no output after {startup_timeout}s")
                if is_alive is not None and not is_alive():
                    # Process is gone; do one final read to drain any bytes it wrote
                    # in the window between our last read and its exit.
                    final = f.read(65536)
                    if final:
                        buf += final
                    break
                time.sleep(_TAIL_POLL_INTERVAL)
                continue
            deadline = None  # first bytes received — no longer waiting for startup
            buf += chunk
            while True:
                indices = [i for i in (buf.find(b"\r"), buf.find(b"\n")) if i != -1]
                if not indices:
                    break
                idx = min(indices)
                line, buf = buf[:idx], buf[idx + 1:]
                if line:
                    yield line.decode("utf-8", errors="replace")
    if buf:
        yield buf.decode("utf-8", errors="replace")


def _pid_matches(pid: int, device: str) -> bool:
    """Return True if PID is alive and its cmdline looks like our dd invocation."""
    cmdline_path = Path(f"/proc/{pid}/cmdline")
    try:
        raw = cmdline_path.read_bytes()
    except OSError:
        return False  # process is gone
    args = raw.rstrip(b"\x00").split(b"\x00")
    if not args:
        return False
    argv0 = os.path.basename(args[0].decode("utf-8", errors="replace"))
    device_bytes = device.encode()
    return argv0 == "dd" and any(device_bytes in a for a in args)


def _expected_bytes(block_size: int, count: int, skip: int, capacity: int | None) -> int | None:
    """Bytes a dd run should copy: `count` blocks (clipped to the device end), or
    everything from the skip offset to the end. None if it can't be known."""
    remaining = max(0, capacity - skip * block_size) if capacity else None
    if count > 0:
        requested = count * block_size
        return min(requested, remaining) if remaining is not None else requested
    return remaining


_RECORDS_OUT_RE = re.compile(r"^\d+\+\d+ records out$")


@dataclass
class DDOutcome:
    """What dd's log says about how the run ended."""
    completed: bool             # dd printed its final records/bytes summary
    bytes_copied: int | None    # from the final summary (None if not completed)
    errors: list[str]           # "dd: ..." error lines, in order


def _read_dd_outcome(path: Path) -> DDOutcome:
    """Parse a whole dd log file for its final summary and any error lines.

    The final summary is a "N+M records out" line followed by "N bytes ... copied".
    Progress lines look like the bytes line too, so only one that follows the
    last "records out" counts. A process that was killed never prints it.
    """
    try:
        text = path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return DDOutcome(completed=False, bytes_copied=None, errors=[])
    lines = [ln.strip() for ln in re.split(r"[\r\n]", text) if ln.strip()]
    errors = [ln for ln in lines if ln.startswith("dd: ") and not ln.startswith("dd: warning")]
    last_out = max((i for i, ln in enumerate(lines) if _RECORDS_OUT_RE.match(ln)), default=None)
    if last_out is None:
        return DDOutcome(completed=False, bytes_copied=None, errors=errors)
    for ln in lines[last_out + 1:]:
        match = _PROGRESS_RE.match(ln)
        if match:
            return DDOutcome(completed=True, bytes_copied=int(match.group(1)), errors=errors)
    return DDOutcome(completed=False, bytes_copied=None, errors=errors)


def _dd_failure(outcome: DDOutcome, returncode: int | None, expected_bytes: int | None) -> str | None:
    """Return why a finished dd run did not pass, or None if it passed.

    returncode is None when the job was reattached after a restart (no Popen to
    wait on) — then the log is the only evidence, so a missing summary fails.
    """
    if outcome.errors:
        more = f" (+{len(outcome.errors) - 1} more)" if len(outcome.errors) > 1 else ""
        return outcome.errors[0] + more
    if returncode not in (0, None):
        return f"dd exited with code {returncode}"
    if not outcome.completed:
        return "dd exited without printing its final summary — the run did not finish (process killed?)"
    if expected_bytes is not None and outcome.bytes_copied != expected_bytes:
        return f"dd stopped early: {outcome.bytes_copied} of {expected_bytes} bytes copied"
    return None


class DDReadTestOperation(OperationBase):
    name = "Read Test (dd)"
    category = "Scan"
    tool = "dd"
    params = [
        ParamSpec(name="block_size",   label="Block size (bytes)",           type="number",  default=1048576, min=4096, max=16777216),
        ParamSpec(name="count",        label="Block count (0 = all)",        type="number",  default=0, min=0),
        ParamSpec(name="skip",         label="Skip blocks from start",       type="number",  default=0, min=0),
        ParamSpec(name="conv_noerror", label="Continue on errors (noerror)", type="boolean", default=False),
        ParamSpec(name="conv_sync",    label="Pad errors with zeros (sync)", type="boolean", default=False),
        ParamSpec(name="iflag_direct", label="Direct I/O (bypass cache)",    type="boolean", default=False),
    ]

    def __init__(self):
        self._cancel_event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._pid: int | None = None           # set independently so cancel() works after reattach
        self._log_path: Path | None = None
        self._device: str | None = None
        self._cmd: list[str] | None = None
        self._block_size: int = 0
        self._percent: float | None = 0.0
        self._message: str | None = "Queued"

    @staticmethod
    def supports(context: DriveContext) -> bool:
        descriptor = context.descriptor
        return descriptor.device_name.startswith("/dev/") and "megaraid" not in descriptor.access_type

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        block_size = int(params["block_size"])
        count = int(params["count"])
        skip = int(params["skip"])
        capacity = context.traits.capacity_bytes

        cmd = ["dd", f"if={device}", "of=/dev/null", f"bs={block_size}", "status=progress"]
        if count > 0:
            cmd.append(f"count={count}")
        if skip > 0:
            cmd.append(f"skip={skip}")
        conv_parts = []
        if params["conv_noerror"]:
            conv_parts.append("noerror")
        if params["conv_sync"]:
            conv_parts.append("sync")
        if conv_parts:
            cmd.append(f"conv={','.join(conv_parts)}")
        if params["iflag_direct"]:
            cmd.append("iflag=direct")

        total_bytes = _expected_bytes(block_size, count, skip, capacity)

        log_path = self._job_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)

        self._device = device
        self._cmd = cmd
        self._block_size = block_size
        self._log_path = log_path
        self._message = "Starting"
        logger.info("starting dd read test on %s: %s", device, " ".join(cmd))

        with open(log_path, "wb") as log_file:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=log_file,
                bufsize=0,
                start_new_session=True,  # detach from parent process group
            )
        self._pid = self._proc.pid

        # Persist reattach data as early as possible after Popen succeeds.
        self._save_reattach()

        if self._cancel_event.is_set():
            self._terminate()

        return self._watch_and_wait(total_bytes, start_offset=0, startup_timeout=_STARTUP_TIMEOUT_SECONDS)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        try:
            pid = int(reattach_data["pid"])
            log_path = Path(reattach_data["log_path"])
        except (KeyError, TypeError, ValueError) as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

        device = context.descriptor.device_name
        block_size = int(params["block_size"])
        count = int(params["count"])
        skip = int(params["skip"])
        capacity = context.traits.capacity_bytes
        total_bytes = _expected_bytes(block_size, count, skip, capacity)

        self._device = device
        self._log_path = log_path
        self._block_size = block_size

        if not _pid_matches(pid, device):
            # dd is gone. If it ended while the backend was down, its log says how.
            outcome = _read_dd_outcome(log_path)
            if outcome.completed or outcome.errors:
                logger.info("dd read test on %s finished while the backend was down; reading result from log", device)
                return self._verdict(outcome, None, total_bytes)
            raise ReattachFailed(
                f"dd process (pid {pid}) is no longer running and its log shows no result — "
                "it was stopped before finishing"
            )

        self._pid = pid
        self._message = "Resuming"
        logger.info("reattaching to dd read test on %s (pid %d)", device, pid)

        # Start tailing from current end of the log so we don't re-emit megabytes of
        # old progress lines, but do pick up any new lines the live process writes.
        start_offset = log_path.stat().st_size if log_path.exists() else 0
        return self._watch_and_wait(total_bytes, start_offset=start_offset)

    def _watch_and_wait(self, total_bytes: int | None, start_offset: int = 0, startup_timeout: float | None = None) -> dict:
        """Consume progress from the log file and wait for the dd process to exit."""
        bytes_read = 0
        last_line = ""
        is_alive = (lambda: Path(f"/proc/{self._pid}").exists()) if self._pid is not None else None

        try:
            for line in _iter_log_lines(
                self._log_path,
                start_offset=start_offset,
                startup_timeout=startup_timeout,
                is_alive=is_alive,
            ):
                last_line = line.strip()
                match = _PROGRESS_RE.match(last_line)
                if match:
                    bytes_read = int(match.group(1))
                    if total_bytes:
                        self._percent = min(100.0, round(bytes_read / total_bytes * 100, 1))
                    self._message = last_line

                if self._cancel_event.is_set():
                    self._terminate()
                    self._message = "Cancelled"
                    raise OperationCancelled()
        except TimeoutError:
            self._terminate()
            if self._cancel_event.is_set():
                self._message = "Cancelled"
                raise OperationCancelled()
            self._message = "Failed"
            raise RuntimeError(
                f"dd produced no output after {startup_timeout}s "
                "(it may be stuck waiting for a sudo password prompt)"
            )

        # Wait for the process to finish.  For a reattached job we can't use
        # Popen.wait() (no Popen object), so poll /proc instead.
        if self._proc is not None:
            returncode = self._proc.wait()
        else:
            returncode = self._poll_until_done()

        if self._cancel_event.is_set():
            self._message = "Cancelled"
            raise OperationCancelled()
        # Decide from the whole log, not just the tail we watched: after a
        # reattach there is no exit code, and a killed dd must not pass.
        return self._verdict(_read_dd_outcome(self._log_path), returncode, total_bytes)

    def _verdict(self, outcome: DDOutcome, returncode: int | None, total_bytes: int | None) -> dict:
        """Turn a finished run's log outcome into the job result, or raise if it failed."""
        failure = _dd_failure(outcome, returncode, total_bytes)
        if failure:
            self._message = "Failed"
            raise RuntimeError(failure)
        bytes_read = outcome.bytes_copied or 0

        self._percent = 100.0
        self._message = "Done"
        logger.info("dd read test on %s completed: %d bytes read", self._device, bytes_read)
        return {"bytes_read": bytes_read, "device": self._device, "block_size": self._block_size}

    def _poll_until_done(self) -> int | None:
        """Poll /proc/<pid> until the process exits (used when no Popen object is available)."""
        if self._pid is None:
            return None
        while Path(f"/proc/{self._pid}").exists():
            if self._cancel_event.is_set():
                self._terminate()
                return None
            time.sleep(0.5)
        return None  # exit code not recoverable without waitpid

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
        return {"pid": self._pid, "log_path": str(self._log_path)}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
        self._terminate()
