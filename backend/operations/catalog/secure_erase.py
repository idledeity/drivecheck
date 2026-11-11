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

shred's verbose output (observed with coreutils 9.7):
    shred: /dev/sda: pass 1/2 (random)...
    shred: /dev/sda: pass 1/2 (random)...54MiB/400MiB 13%
    ...
    shred: /dev/sda: pass 1/2 (random)...400MiB/400MiB 100%
    shred: /dev/sda: pass 2/2 (000000)...
    ...
    shred: /dev/sda: pass 2/2 (000000)...400MiB/400MiB 100%
shred prints no completion line. Progress (every ~5s) is only shown for a pass
that takes that long, and such a pass then ends with a "100%" line — so for a
real drive, the last pass's 100% line is the evidence the run finished. Any
other "shred: <device>: ..." line is an error.
"""

import logging
import re
import shutil
from pathlib import Path

from drives.drive_models import DriveContext
from operations.logged_process import LoggedProcessOperation
from operations.operation import ParamSpec

logger = logging.getLogger(__name__)

# "shred: /dev/sda: pass 2/3 (random)...  45%"
_PROGRESS_RE = re.compile(r"pass\s+(\d+)/(\d+).*?(\d+)%")
# "shred: /dev/sda: pass 2/3 (random)..." (no % yet — pass just started)
_PASS_START_RE = re.compile(r"pass\s+(\d+)/(\d+)")

_SBIN_PATH = "/usr/sbin:/usr/local/sbin:/sbin"

# A pass line: "shred: /dev/sda: pass 2/3 (random)...[progress]"
_PASS_LINE_RE = re.compile(r"^shred: .*: pass (\d+)/(\d+) \([^)]*\)\.\.\.(.*)$")


def _read_shred_outcome(path: Path, total_passes: int) -> tuple[bool, list[str]]:
    """Scan a whole shred log; return (last pass reached 100%, error lines)."""
    try:
        text = path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return False, []
    finished = False
    errors = []
    for line in (ln.strip() for ln in re.split(r"[\r\n]", text)):
        if not line:
            continue
        m = _PASS_LINE_RE.match(line)
        if m is None:
            errors.append(line)
        elif int(m.group(1)) == total_passes and m.group(3).endswith("100%"):
            finished = True
    return finished, errors


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

    @classmethod
    def summarize(cls, result: dict) -> str | None:
        passes = result["total_passes"]
        return f"Erased in {passes} pass{'es' if passes != 1 else ''}"

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

    def _finished_in_log(self) -> bool:
        finished, errors = _read_shred_outcome(self._log_path, self._total_passes)
        return finished or bool(errors)

    def _verdict(self, returncode: int | None) -> dict:
        finished, errors = _read_shred_outcome(self._log_path, self._total_passes)
        failure = None
        if errors:
            more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
            failure = errors[0] + more
        elif returncode not in (0, None):
            failure = f"shred exited with code {returncode}"
        elif returncode is None and not finished:
            # Reattached: no exit code, so the last pass's 100% line is the only proof.
            failure = (
                f"shred did not report finishing pass {self._total_passes}/{self._total_passes} — "
                "the run did not finish (process killed?)"
            )
        if failure:
            self._message = "Failed"
            raise RuntimeError(failure)

        self._percent = 100.0
        self._message = "Done"
        logger.info("secure erase on %s completed (%d total pass(es))", self._device, self._total_passes)
        return {"device": self._device, "total_passes": self._total_passes}
