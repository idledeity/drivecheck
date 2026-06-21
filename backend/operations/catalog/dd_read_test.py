"""
operations.catalog.dd_read_test — sequential full-disk read test using dd.

Reads every byte of the target device with `dd ... of=/dev/null`, exercising
the drive without writing to it. Progress is parsed from dd's
`status=progress` stderr output, which dd updates in place using carriage
returns rather than newlines — only the final summary line ends with '\\n'.
"""

import logging
import re
import select
import subprocess
import threading

from operations.operation import OperationBase, OperationCancelled, OperationProgress, ParamSpec
from drives.drive_models import DriveContext

logger = logging.getLogger(__name__)

_PROGRESS_RE = re.compile(r"^(\d+) bytes")

# dd's status=progress timer fires ~once/second once it's actually running,
# so a longer silence means dd never started (e.g. sudo stuck on a password
# prompt, bad device path, permission denied).
_STARTUP_TIMEOUT_SECONDS = 15


def _iter_dd_lines(stream, startup_timeout=None):
    """Yield decoded stderr lines from dd, splitting on '\\r' as well as '\\n'.

    Raises TimeoutError if startup_timeout is given and no output at all
    arrives before the first line is seen.
    """
    buf = b""
    seen_output = False
    while True:
        if startup_timeout is not None and not seen_output:
            ready, _, _ = select.select([stream], [], [], startup_timeout)
            if not ready:
                raise TimeoutError(f"no output after {startup_timeout}s")
        chunk = stream.read(4096)
        if not chunk:
            break
        seen_output = True
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

        # Bytes expected to be read, for progress percentage.
        # count takes priority; fall back to capacity minus any skipped region.
        if count > 0:
            total_bytes: int | None = count * block_size
        elif capacity:
            total_bytes = max(0, capacity - skip * block_size)
        else:
            total_bytes = None

        self._message = "Starting"
        logger.info("starting dd read test on %s: %s", device, " ".join(cmd))
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        if self._cancel_event.is_set():
            self._proc.terminate()

        bytes_read = 0
        last_line = ""
        try:
            for line in _iter_dd_lines(self._proc.stderr, startup_timeout=_STARTUP_TIMEOUT_SECONDS):
                last_line = line.strip()
                match = _PROGRESS_RE.match(last_line)
                if match:
                    bytes_read = int(match.group(1))
                    if total_bytes:
                        self._percent = min(100.0, round(bytes_read / total_bytes * 100, 1))
                    self._message = last_line
        except TimeoutError:
            self._proc.terminate()
            self._proc.wait()
            if self._cancel_event.is_set():
                self._message = "Cancelled"
                raise OperationCancelled()
            self._message = "Failed"
            raise RuntimeError(
                f"dd produced no output after {_STARTUP_TIMEOUT_SECONDS}s "
                "(it may be stuck waiting for a sudo password prompt)"
            )

        returncode = self._proc.wait()

        if self._cancel_event.is_set():
            self._message = "Cancelled"
            raise OperationCancelled()
        if returncode != 0:
            self._message = "Failed"
            raise RuntimeError(last_line or f"dd exited with code {returncode}")

        self._percent = 100.0
        self._message = "Done"
        logger.info("dd read test on %s completed: %d bytes read", device, bytes_read)
        return {"bytes_read": bytes_read, "device": device, "block_size": block_size}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
        if self._proc is not None:
            self._proc.terminate()
