"""
operations.catalog.secure_erase — Secure data wipe using shred.

Overwrites the entire device with one or more random passes followed by a final
zero-fill pass, making previous data unrecoverable from the drive platters or
cells. Uses GNU shred(1), which handles the OS-level write path on HDDs, SSDs,
and NVMe drives.

Note: SSDs and NVMe drives with wear-leveling may not expose every cell to a
software shred. For SSDs, ATA Secure Erase (via hdparm) or the drive's own
cryptographic erase command is more thorough — this operation is a best-effort
software wipe using the normal write path.

THIS OPERATION DESTROYS ALL DATA ON THE TARGET DEVICE PERMANENTLY. It refuses to
run if any partition of the device is currently mounted, checked via /proc/mounts
at startup.

shred's verbose output format (uses \\r for in-place updates):
    shred: /dev/sda: pass 1/3 (random)...  12%
    shred: /dev/sda: pass 1/3 (random)...  25%
    ...
    shred: /dev/sda: pass 3/3 (000000)...

stderr is redirected to a log file (not a pipe) so the job survives a backend
restart: the running shred process can be re-identified by PID + /proc cmdline
and monitoring resumes by tailing the log file.
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
from operations.catalog.dd_read_test import _iter_log_lines
from drives.drive_models import DriveContext
from system_utils import paths

logger = logging.getLogger(__name__)

# "shred: /dev/sda: pass 2/3 (random)...  45%"
_PROGRESS_RE = re.compile(r"pass\s+(\d+)/(\d+).*?(\d+)%")
# "shred: /dev/sda: pass 2/3 (random)..." (no % yet — pass just started)
_PASS_START_RE = re.compile(r"pass\s+(\d+)/(\d+)")

_STARTUP_TIMEOUT_SECONDS = 30
_SBIN_PATH = "/usr/sbin:/usr/local/sbin:/sbin"


def _find_shred() -> str:
    """Locate the shred binary, checking PATH then common sbin locations."""
    found = shutil.which("shred") or shutil.which("shred", path=_SBIN_PATH)
    if not found:
        raise RuntimeError("shred not found — install GNU coreutils")
    return found


def _is_device_mounted(device: str) -> bool:
    """Return True if any partition of device appears in /proc/mounts."""
    try:
        mounts = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return False
    return any(line.split(" ", 1)[0].startswith(device) for line in mounts)


def _pid_matches(pid: int, device: str) -> bool:
    """Return True if PID is alive and its cmdline looks like our shred invocation."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False
    args = raw.rstrip(b"\x00").split(b"\x00")
    if not args:
        return False
    argv0 = os.path.basename(args[0].decode("utf-8", errors="replace"))
    device_bytes = device.encode()
    return argv0 == "shred" and any(device_bytes in a for a in args)


class SecureEraseOperation(OperationBase):
    name = "Secure Erase (shred)"
    category = "Maintenance"
    tool = "shred"
    params = [
        ParamSpec(name="passes",    label="Random overwrite passes", type="number",  default=1, min=1, max=7),
        ParamSpec(name="zero_fill", label="Final zero-fill pass",    type="boolean", default=True),
    ]

    def __init__(self):
        self._cancel_event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._pid: int | None = None
        self._log_path: Path | None = None
        self._device: str | None = None
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
        passes = int(params["passes"])
        zero_fill = bool(params["zero_fill"])
        total_passes = passes + (1 if zero_fill else 0)

        if _is_device_mounted(device):
            self._message = "Failed"
            raise RuntimeError(f"{device} is currently mounted — unmount all partitions before erasing")

        cmd = [_find_shred(), f"--iterations={passes}", "--verbose"]
        if zero_fill:
            cmd.append("--zero")
        cmd.append(device)

        log_path = self._job_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)

        self._device = device
        self._log_path = log_path
        self._message = "Starting"
        logger.info("starting secure erase on %s: %s", device, " ".join(cmd))

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

        return self._watch_and_wait(total_passes, start_offset=0, startup_timeout=_STARTUP_TIMEOUT_SECONDS)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        try:
            pid = int(reattach_data["pid"])
            log_path = Path(reattach_data["log_path"])
        except (KeyError, TypeError, ValueError) as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

        device = context.descriptor.device_name
        if not _pid_matches(pid, device):
            raise ReattachFailed(
                f"shred process (pid {pid}) is no longer running or no longer matches device {device}"
            )

        passes = int(params["passes"])
        zero_fill = bool(params["zero_fill"])
        total_passes = passes + (1 if zero_fill else 0)

        self._pid = pid
        self._device = device
        self._log_path = log_path
        self._message = "Resuming"
        logger.info("reattaching to secure erase on %s (pid %d)", device, pid)

        start_offset = log_path.stat().st_size if log_path.exists() else 0
        return self._watch_and_wait(total_passes, start_offset=start_offset)

    def _watch_and_wait(self, total_passes: int, start_offset: int = 0, startup_timeout: float | None = None) -> dict:
        device = self._device
        is_alive = (lambda: Path(f"/proc/{self._pid}").exists()) if self._pid is not None else None

        try:
            for line in _iter_log_lines(
                self._log_path,
                start_offset=start_offset,
                startup_timeout=startup_timeout,
                is_alive=is_alive,
            ):
                if self._cancel_event.is_set():
                    self._terminate()
                    self._message = "Cancelled"
                    raise OperationCancelled()

                line = line.strip()
                m = _PROGRESS_RE.search(line)
                if m:
                    current_pass = int(m.group(1))
                    pass_pct = float(m.group(3))
                    self._percent = round(
                        ((current_pass - 1) * 100 + pass_pct) / total_passes, 1
                    )
                    self._message = line.split(": ", 2)[-1]
                    continue
                m = _PASS_START_RE.search(line)
                if m:
                    current_pass = int(m.group(1))
                    self._percent = round((current_pass - 1) * 100 / total_passes, 1)
                    self._message = line.split(": ", 2)[-1]

        except TimeoutError:
            self._terminate()
            if self._cancel_event.is_set():
                self._message = "Cancelled"
                raise OperationCancelled()
            self._message = "Failed"
            raise RuntimeError(f"shred produced no output after {startup_timeout}s")

        if self._proc is not None:
            returncode = self._proc.wait()
        else:
            returncode = self._poll_until_done()

        if self._cancel_event.is_set():
            self._message = "Cancelled"
            raise OperationCancelled()
        if returncode != 0 and returncode is not None:
            self._message = "Failed"
            raise RuntimeError(f"shred exited with code {returncode}")

        self._percent = 100.0
        self._message = "Done"
        logger.info("secure erase on %s completed (%d total pass(es))", device, total_passes)
        return {"device": device, "total_passes": total_passes}

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
