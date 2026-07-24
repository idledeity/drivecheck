"""
operations.catalog.dd_write_test — sequential full-disk write test using dd.

Writes zeros from /dev/zero to the target device with `dd if=/dev/zero
of=<device>`, measuring write throughput across the drive surface.

dd's progress output (`status=progress`) is redirected to a file rather than
piped back to the Python process, for the same reasons as dd_read_test:
  1. Eliminates a SIGPIPE hazard when the backend restarts (closes fds ≥ 3
     before re-exec, which would kill dd on its next stderr write).
  2. Makes the job reattachable — the log file persists across restarts and
     the running dd process can be re-identified by PID + /proc cmdline.

THIS OPERATION DESTROYS ALL DATA ON THE TARGET DEVICE. It refuses to run if any
partition of the device is currently mounted, checked via /proc/mounts at startup.
"""

import logging
import os
import re
import signal
import threading
import time
from pathlib import Path

from operations.operation import OperationBase, OperationCancelled, OperationProgress, ParamSpec, ReattachFailed
from operations.catalog.dd_read_test import _iter_log_lines, _pid_matches
from drives.drive_models import DriveContext
from system_utils import paths

import subprocess

logger = logging.getLogger(__name__)

_PROGRESS_RE = re.compile(r"^(\d+) bytes")
_STARTUP_TIMEOUT_SECONDS = 15


def _is_device_mounted(device: str) -> bool:
    """Return True if any partition of device appears in /proc/mounts."""
    try:
        mounts = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return False
    return any(line.split(" ", 1)[0].startswith(device) for line in mounts)


class DDWriteTestOperation(OperationBase):
    name = "Write Test (dd)"
    category = "Scan"
    tool = "dd"
    destructive = True
    params = [
        ParamSpec(name="block_size",   label="Block size (bytes)",        type="number",  default=1048576, min=4096, max=16777216),
        ParamSpec(name="count",        label="Block count (0 = all)",     type="number",  default=0, min=0),
        ParamSpec(name="skip",         label="Skip blocks from start",    type="number",  default=0, min=0),
        ParamSpec(name="conv_fsync",   label="Sync to disk when done",    type="boolean", default=True),
        ParamSpec(name="oflag_direct", label="Direct I/O (bypass cache)", type="boolean", default=False),
    ]

    def __init__(self):
        self._cancel_event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._pid: int | None = None
        self._log_path: Path | None = None
        self._device: str | None = None
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

        if _is_device_mounted(device):
            self._message = "Failed"
            raise RuntimeError(
                f"{device} is currently mounted — unmount all partitions before running a write test"
            )

        cmd = ["dd", "if=/dev/zero", f"of={device}", f"bs={block_size}", "status=progress"]
        if count > 0:
            cmd.append(f"count={count}")
        if skip > 0:
            cmd.append(f"seek={skip}")
        conv_parts = []
        if params["conv_fsync"]:
            conv_parts.append("fsync")
        if conv_parts:
            cmd.append(f"conv={','.join(conv_parts)}")
        if params["oflag_direct"]:
            cmd.append("oflag=direct")

        if count > 0:
            total_bytes: int | None = count * block_size
        elif capacity:
            total_bytes = max(0, capacity - skip * block_size)
        else:
            total_bytes = None

        log_path = self._job_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)

        self._device = device
        self._log_path = log_path
        self._block_size = block_size
        self._message = "Starting"
        logger.info("starting dd write test on %s: %s", device, " ".join(cmd))

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

        return self._watch_and_wait(total_bytes, start_offset=0, startup_timeout=_STARTUP_TIMEOUT_SECONDS)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        try:
            pid = int(reattach_data["pid"])
            log_path = Path(reattach_data["log_path"])
        except (KeyError, TypeError, ValueError) as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

        device = context.descriptor.device_name
        if not _pid_matches(pid, device):
            raise ReattachFailed(
                f"dd process (pid {pid}) is no longer running or no longer matches device {device}"
            )

        block_size = int(params["block_size"])
        count = int(params["count"])
        skip = int(params["skip"])
        capacity = context.traits.capacity_bytes

        if count > 0:
            total_bytes: int | None = count * block_size
        elif capacity:
            total_bytes = max(0, capacity - skip * block_size)
        else:
            total_bytes = None

        self._pid = pid
        self._device = device
        self._log_path = log_path
        self._block_size = block_size
        self._message = "Resuming"
        logger.info("reattaching to dd write test on %s (pid %d)", device, pid)

        start_offset = log_path.stat().st_size if log_path.exists() else 0
        return self._watch_and_wait(total_bytes, start_offset=start_offset)

    def _watch_and_wait(self, total_bytes: int | None, start_offset: int = 0, startup_timeout: float | None = None) -> dict:
        device = self._device
        bytes_written = 0
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
                    bytes_written = int(match.group(1))
                    if total_bytes:
                        self._percent = min(100.0, round(bytes_written / total_bytes * 100, 1))
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

        if self._proc is not None:
            returncode = self._proc.wait()
        else:
            returncode = self._poll_until_done()

        if self._cancel_event.is_set():
            self._message = "Cancelled"
            raise OperationCancelled()
        if returncode != 0 and returncode is not None:
            self._message = "Failed"
            raise RuntimeError(last_line or f"dd exited with code {returncode}")

        self._percent = 100.0
        self._message = "Done"
        logger.info("dd write test on %s completed: %d bytes written", device, bytes_written)
        return {"bytes_written": bytes_written, "device": device, "block_size": self._block_size}

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
        return {"pid": self._pid, "log_path": str(self._log_path), "device": self._device}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
        self._terminate()
