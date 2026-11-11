"""
operations.catalog.secure_erase — Secure data wipe using shred.

Overwrites the entire device with one or more random passes followed by a final
zero-fill pass, making previous data unrecoverable from the drive platters or
cells. Uses GNU shred(1), which handles the OS-level write path on HDDs, SSDs,
and NVMe drives. Process handling and restart reattachment live in
LoggedProcessOperation (operations.logged_process).

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
"""

import logging
import re
import shutil

from drives.drive_models import DriveContext
from operations.logged_process import LoggedProcessOperation
from operations.operation import ParamSpec

logger = logging.getLogger(__name__)

# "shred: /dev/sda: pass 2/3 (random)...  45%"
_PROGRESS_RE = re.compile(r"pass\s+(\d+)/(\d+).*?(\d+)%")
# "shred: /dev/sda: pass 2/3 (random)..." (no % yet — pass just started)
_PASS_START_RE = re.compile(r"pass\s+(\d+)/(\d+)")

_SBIN_PATH = "/usr/sbin:/usr/local/sbin:/sbin"


def _find_shred() -> str:
    """Locate the shred binary, checking PATH then common sbin locations."""
    found = shutil.which("shred") or shutil.which("shred", path=_SBIN_PATH)
    if not found:
        raise RuntimeError("shred not found — install GNU coreutils")
    return found


class SecureEraseOperation(LoggedProcessOperation):
    name = "Secure Erase (shred)"
    category = "Maintenance"
    tool = "shred"
    program = "shred"
    destructive = True
    params = [
        ParamSpec(name="passes",    label="Random overwrite passes", type="number",  default=1, min=1, max=7),
        ParamSpec(name="zero_fill", label="Final zero-fill pass",    type="boolean", default=True),
    ]

    def __init__(self):
        super().__init__()
        self._total_passes = 1

    def _configure(self, context: DriveContext, params: dict) -> None:
        self._total_passes = int(params["passes"]) + (1 if bool(params["zero_fill"]) else 0)

    def _build_command(self, context: DriveContext, params: dict) -> list[str]:
        cmd = [_find_shred(), f"--iterations={int(params['passes'])}", "--verbose"]
        if bool(params["zero_fill"]):
            cmd.append("--zero")
        cmd.append(context.descriptor.device_name)
        return cmd

    def _on_log_line(self, line: str) -> None:
        m = _PROGRESS_RE.search(line)
        if m:
            current_pass = int(m.group(1))
            pass_pct = float(m.group(3))
            self._percent = round(((current_pass - 1) * 100 + pass_pct) / self._total_passes, 1)
            self._message = line.split(": ", 2)[-1]
            return
        m = _PASS_START_RE.search(line)
        if m:
            current_pass = int(m.group(1))
            self._percent = round((current_pass - 1) * 100 / self._total_passes, 1)
            self._message = line.split(": ", 2)[-1]

    def _verdict(self, returncode: int | None) -> dict:
        if returncode != 0 and returncode is not None:
            self._message = "Failed"
            raise RuntimeError(f"shred exited with code {returncode}")

        self._percent = 100.0
        self._message = "Done"
        logger.info("secure erase on %s completed (%d total pass(es))", self._device, self._total_passes)
        return {"device": self._device, "total_passes": self._total_passes}
