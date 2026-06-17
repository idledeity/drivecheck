"""
operations.catalog.smart_self_test_base — Shared logic for SMART self-tests.

`test_type` is left as an abstract property, so this class still has an
unimplemented abstractmethod and registry._discover() skips it via
inspect.isabstract() — even though it lives in operations/catalog alongside
the concrete short/long test operations that subclass it and set `test_type`.

ATA and SCSI/SAS drives report self-test progress completely differently in
smartctl's JSON, so the poll loop dispatches on drive_type:
  - ATA: `ata_smart_data.self_test.status.remaining_percent` counts down from
    100, giving a real percent-complete.
  - SCSI/SAS: `scsi_self_test_0.self_test_in_progress` is just a bool (no
    percent field exists in smartctl's JSON for an in-progress SCSI
    self-test, confirmed by observing a live run) — progress stays
    indeterminate (percent=None) until the entry reports a final result.
"""

import threading
from abc import abstractmethod

from drive_models import DriveContext, DriveType
from drive_tools import smartctl
from drive_tools.smartctl import SelfTestType
from drive_tools.timeout import ProbeTimeout
from operations.operation import OperationBase, OperationCancelled, OperationProgress

_POLL_INTERVAL_SECONDS = 30
_SMARTCTL_CALL_TIMEOUT_SECONDS = 30


class SmartSelfTestOperation(OperationBase):
    """Starts a SMART self-test and polls smartctl until it finishes."""

    category = "Test"
    tool = "smartctl"

    @property
    @abstractmethod
    def test_type(self) -> SelfTestType:
        """Self-test mode this operation starts. Set by subclasses."""

    def __init__(self):
        self._cancel_event = threading.Event()
        self._percent: float | None = 0.0
        self._message: str | None = "Queued"

    @staticmethod
    def supports(context: DriveContext) -> bool:
        return context.traits.drive_type in (DriveType.HDD, DriveType.SSD, DriveType.SAS)

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        access_type = context.descriptor.access_type
        drive_type = context.traits.drive_type

        self._message = "Starting"
        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            start_result = smartctl.self_test_start(device, access_type, self.test_type)
        exit_status = start_result.get("smartctl", {}).get("exit_status", 0)
        if exit_status != 0:
            messages = [m.get("string", "") for m in start_result.get("smartctl", {}).get("messages", [])]
            self._message = "Failed"
            raise RuntimeError("; ".join(filter(None, messages)) or "smartctl failed to start self-test")

        while True:
            if self._cancel_event.wait(_POLL_INTERVAL_SECONDS):
                with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
                    smartctl.self_test_abort(device, access_type)
                self._message = "Cancelled"
                raise OperationCancelled()

            with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
                data = smartctl.attributes_all(device, access_type)

            result_string = self._scsi_status(data) if drive_type == DriveType.SAS else self._ata_status(data)
            if result_string is None:
                continue  # still running; self._percent/_message already updated

            self._percent = 100.0
            if "without error" in result_string.lower() or result_string == "Completed":
                self._message = "Done"
                return {"device": device, "test_type": self.test_type.value, "result": result_string}
            self._message = "Failed"
            raise RuntimeError(f"self-test ended: {result_string}")

    def _ata_status(self, data: dict) -> str | None:
        """Update progress from `ata_smart_data.self_test.status`. Returns the final result string, or None if still running."""
        status = data.get("ata_smart_data", {}).get("self_test", {}).get("status", {})
        remaining = status.get("remaining_percent")
        if remaining is None:
            return status.get("string", "Unknown")
        self._percent = max(0.0, 100.0 - remaining)
        self._message = status.get("string", "In progress")
        return None

    def _scsi_status(self, data: dict) -> str | None:
        """Update progress from `scsi_self_test_0`. Returns the final result string, or None if still running.

        smartctl's JSON has no percent-complete field for an in-progress SCSI
        self-test (confirmed against a live run) — only a boolean — so
        progress stays indeterminate (percent=None) until it ends.
        """
        entry = data.get("scsi_self_test_0", {})
        result = entry.get("result", {})
        if entry.get("self_test_in_progress"):
            self._percent = None
            self._message = result.get("string", "In progress")
            return None
        return result.get("string", "Unknown")

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
