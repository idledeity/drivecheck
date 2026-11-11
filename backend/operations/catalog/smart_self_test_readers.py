"""
operations.catalog.smart_self_test_readers — Reading self-test state from smartctl's JSON.

Every drive self-test is started (`smartctl -t`), aborted (`-X`) and polled
(`-a -j`) the same way; only where `smartctl -a -j` reports the test's state
differs by interface. Each reader here answers the same few questions for one
interface, so SmartSelfTestOperation can run one procedure for all of them:

  - ATA (HDD/SSD): `ata_smart_data.self_test.status`, whose `remaining_percent`
    counts down while a test runs, and the `ata_smart_self_test_log` table.
  - SCSI/SAS: `scsi_self_test_0..N`; only a bool while running (smartctl's JSON
    has no percent-complete for an in-progress SCSI self-test, confirmed on a
    live run), so progress stays indeterminate.
  - NVMe: `nvme_self_test_log`, with the running operation's code and percent
    and a table of finished tests.

Readers are pure functions of the JSON: they make no smartctl calls and hold no
state. Not OperationBase subclasses, so operation_registry.discover() ignores
this module.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass

from drives.drive_models import DriveType
from drives.tools.smartctl import SelfTestType


@dataclass(frozen=True)
class Running:
    """A self-test is in progress."""
    percent: float | None   # None when the drive doesn't report it (SAS)
    message: str


@dataclass(frozen=True)
class Finished:
    """No self-test is running; this is the outcome the drive reports."""
    result: str     # the drive's own wording, e.g. "Completed without error"
    passed: bool


class SelfTestReader(ABC):
    """Reads one interface's self-test state from `smartctl -a -j` output."""

    # Self-test types this interface implements (conveyance is ATA-only).
    test_types: frozenset[SelfTestType]

    @abstractmethod
    def status(self, data: dict) -> Running | Finished:
        """The drive's current self-test state. Finished may still be a previous
        test's result; the operation decides whether it belongs to this run."""

    @abstractmethod
    def log(self, data: dict) -> list[dict]:
        """The self-test log entries, newest first. Compared before and after
        the start to see that the drive recorded a new test."""

    @abstractmethod
    def start_hours(self, data: dict) -> int | None:
        """Power-on hours to record at the start, to recognise this test again
        after a backend restart (see running_hours / completed_at)."""

    @abstractmethod
    def running_hours(self, data: dict) -> int | None:
        """Hours stamped on the running test, if the drive reports any. 0 or None
        means unknown; a different non-zero value means another test is running."""

    @abstractmethod
    def completed_at(self, data: dict, start_hours: int) -> Finished | None:
        """The finished log entry recorded for a test started at start_hours, if any."""


def _ata_scsi_passed(result: str) -> bool:
    # Drives word success differently: "Completed" (SAS), "completed without error" (ATA).
    return "without error" in result.lower() or result == "Completed"


class AtaReader(SelfTestReader):
    test_types = frozenset({SelfTestType.SHORT, SelfTestType.LONG, SelfTestType.CONVEYANCE})

    def status(self, data: dict) -> Running | Finished:
        status = data.get("ata_smart_data", {}).get("self_test", {}).get("status", {})
        remaining = status.get("remaining_percent")
        if remaining is None:
            result = status.get("string", "Unknown")
            return Finished(result, _ata_scsi_passed(result))
        return Running(max(0.0, 100.0 - remaining), status.get("string", "In progress"))

    def log(self, data: dict) -> list[dict]:
        return data.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])

    def start_hours(self, data: dict) -> int | None:
        # Some ATA drives show the in-progress log entry as "NOW" (JSON:
        # lifetime_hours=0) until the test completes, so the log can't be relied
        # on at start. The top-level power_on_time.hours is always populated, and
        # on the drives observed the completed entry is stamped with that value.
        return data.get("power_on_time", {}).get("hours")

    def running_hours(self, data: dict) -> int | None:
        # 0 ("NOW") on some drives until the test completes; others (seen on a
        # Seagate Exos X16) stamp the real hours at start.
        table = self.log(data)
        return table[0].get("lifetime_hours") if table else None

    def completed_at(self, data: dict, start_hours: int) -> Finished | None:
        for entry in self.log(data):
            if entry.get("lifetime_hours") == start_hours:
                result = entry.get("status", {}).get("string", "Unknown")
                return Finished(result, _ata_scsi_passed(result))
        return None


class ScsiReader(SelfTestReader):
    test_types = frozenset({SelfTestType.SHORT, SelfTestType.LONG})

    def status(self, data: dict) -> Running | Finished:
        entry = data.get("scsi_self_test_0", {})
        result = entry.get("result", {})
        if entry.get("self_test_in_progress"):
            return Running(None, result.get("string", "In progress"))
        text = result.get("string", "Unknown")
        return Finished(text, _ata_scsi_passed(text))

    def log(self, data: dict) -> list[dict]:
        entries = []
        while (entry := data.get(f"scsi_self_test_{len(entries)}")) is not None:
            entries.append(entry)
        return entries

    def start_hours(self, data: dict) -> int | None:
        # SAS in-progress entries carry no hours, so use the drive's current
        # power-on hours; the finished entry is stamped with the same value.
        return data.get("power_on_time", {}).get("hours")

    def running_hours(self, data: dict) -> int | None:
        return data.get("scsi_self_test_0", {}).get("power_on_time", {}).get("hours")

    def completed_at(self, data: dict, start_hours: int) -> Finished | None:
        entry = data.get("scsi_self_test_0", {})
        if entry.get("power_on_time", {}).get("hours") != start_hours:
            return None
        result = entry.get("result", {}).get("string", "Unknown")
        return Finished(result, _ata_scsi_passed(result))


# NVMe current_self_test_operation.value when no test is running.
_NVME_OP_NONE = 0
# NVMe self_test_result.value for a test that completed without error.
_NVME_RESULT_PASS = 0


class NvmeReader(SelfTestReader):
    # Field names and meanings are carried over from the previous NVMe
    # operation; no real NVMe self-test output has been captured to test them yet.

    test_types = frozenset({SelfTestType.SHORT, SelfTestType.LONG})

    def status(self, data: dict) -> Running | Finished:
        log = data.get("nvme_self_test_log", {})
        operation = log.get("current_self_test_operation", {})
        if operation.get("value", _NVME_OP_NONE) != _NVME_OP_NONE:
            pct = log.get("current_self_test_completion_percent")
            return Running(float(pct) if pct is not None else None, operation.get("string", "In progress"))
        table = self.log(data)
        if not table:
            return Finished("Unknown (no log entry)", False)
        return self._finished(table[0])

    def log(self, data: dict) -> list[dict]:
        return data.get("nvme_self_test_log", {}).get("table", [])

    def start_hours(self, data: dict) -> int | None:
        # UNVERIFIED: if NVMe drives only add a log entry when a test finishes,
        # table[0] at start is the previous test, and completed_at() after a
        # restart would match that test rather than ours. Needs real output
        # captured before, during and after an NVMe self-test to settle.
        table = self.log(data)
        return table[0].get("power_on_hours") if table else None

    def running_hours(self, data: dict) -> int | None:
        table = self.log(data)
        return table[0].get("power_on_hours") if table else None

    def completed_at(self, data: dict, start_hours: int) -> Finished | None:
        for entry in self.log(data):
            if entry.get("power_on_hours") == start_hours:
                return self._finished(entry)
        return None

    @staticmethod
    def _finished(entry: dict) -> Finished:
        result = entry.get("self_test_result", {})
        return Finished(result.get("string", "Unknown"), result.get("value", -1) == _NVME_RESULT_PASS)


_READERS: dict[DriveType, SelfTestReader] = {
    DriveType.HDD: AtaReader(),
    DriveType.SSD: AtaReader(),
    DriveType.SAS: ScsiReader(),
    DriveType.NVME: NvmeReader(),
}


def reader_for(drive_type: DriveType) -> SelfTestReader | None:
    """The reader for a drive's interface, or None if it has no self-test support."""
    return _READERS.get(drive_type)
