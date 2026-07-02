"""
operations.catalog.nvme_self_test_base — Shared logic for NVMe self-tests.

NVMe drives expose their own self-test mechanism via the NVMe Self-test
command, accessible through smartctl -t short/long. Progress and results are
read from nvme_self_test_log in smartctl's JSON output, which has a different
structure than the ATA/SCSI self-test log:

  - In-progress indicator: nvme_self_test_log.current_self_test_operation.value
    (0 = none, 1 = short, 2 = extended)
  - Completion %: nvme_self_test_log.current_self_test_completion_percent
  - Log table: nvme_self_test_log.table[], each entry has:
    - self_test_result.value (0 = passed, non-zero = failed/aborted)
    - self_test_result.string  (human-readable outcome)
    - power_on_hours (used as the reattach correlator, same strategy as ATA)

`test_type` is abstract; concrete subclasses set it to SHORT or LONG.
"""

import logging
import threading
from abc import abstractmethod

from drives.drive_models import DriveContext, DriveType
from drives.tools import smartctl
from drives.tools.smartctl import SelfTestType
from drives.tools.timeout import ProbeTimeout
from operations.operation import OperationBase, OperationCancelled, OperationProgress, ReattachFailed

logger = logging.getLogger(__name__)

_POLL_INTERVAL_SECONDS = 30
_SMARTCTL_CALL_TIMEOUT_SECONDS = 30

# NVMe self-test operation codes in nvme_self_test_log
_NVME_OP_NONE = 0
_NVME_OP_SHORT = 1
_NVME_OP_EXTENDED = 2

# NVMe self-test result values
_NVME_RESULT_PASS = 0
_NVME_RESULT_ABORTED_BY_HOST = 5


class NvmeSelfTestOperation(OperationBase):
    """Starts a NVMe self-test and polls smartctl until it finishes."""

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
        self._start_hours: int | None = None
        self._device: str | None = None
        self._access_type: str | None = None

    @staticmethod
    def supports(context: DriveContext) -> bool:
        return context.traits.drive_type == DriveType.NVME

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        access_type = context.descriptor.access_type
        self._device = device
        self._access_type = access_type

        self._message = "Starting"
        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            start_result = smartctl.self_test_start(device, access_type, self.test_type)
        if not start_result.success:
            self._message = "Failed"
            raise RuntimeError(start_result.message or "smartctl failed to start NVMe self-test")

        return self._poll_until_done(device, access_type, capture_start_hours=True)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        try:
            device = reattach_data["device"]
            access_type = reattach_data["access_type"]
            poh_expected = reattach_data.get("start_hours")
        except KeyError as e:
            raise ReattachFailed(f"incomplete reattach data: {e}") from e

        if poh_expected is None:
            raise ReattachFailed("power-on-hours not captured before restart — cannot confirm which self-test to resume")

        self._device = device
        self._access_type = access_type
        self._message = "Checking"
        logger.info("reattaching to NVMe self-test on %s (expected start hours: %s)", device, poh_expected)

        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            data = smartctl.attributes_all(device, access_type)

        in_progress, current_poh = self._in_progress_status(data)
        if in_progress:
            if current_poh != poh_expected:
                raise ReattachFailed(
                    f"a different self-test is now in progress on {device} "
                    f"(expected start hours {poh_expected}, found {current_poh})"
                )
            self._start_hours = poh_expected
            logger.info("reattached to in-progress NVMe self-test on %s", device)
            return self._poll_until_done(device, access_type, capture_start_hours=False)

        result_string = self._find_completed_result(data, poh_expected)
        if result_string is not None:
            logger.info("NVMe self-test on %s finished during downtime: %s", device, result_string)
            return self._finalize(device, result_string, pass_result=result_string == "Completed without error")

        raise ReattachFailed(
            f"could not confirm previous NVMe self-test on {device} — it may have completed, "
            "been aborted, or been replaced by a different test while the backend was down"
        )

    def _poll_until_done(self, device: str, access_type: str, capture_start_hours: bool) -> dict:
        first_poll = True
        while True:
            if self._cancel_event.wait(_POLL_INTERVAL_SECONDS):
                with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
                    smartctl.self_test_abort(device, access_type)
                self._message = "Cancelled"
                raise OperationCancelled()

            with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
                data = smartctl.attributes_all(device, access_type)

            if first_poll and capture_start_hours:
                self._start_hours = self._extract_start_hours(data)
                self._save_reattach()
                first_poll = False

            done, passed, result_string = self._nvme_status(data)
            if not done:
                logger.debug("NVMe self-test poll for %s: percent=%s message=%s", device, self._percent, self._message)
                continue

            return self._finalize(device, result_string, pass_result=passed)

    def _finalize(self, device: str, result_string: str, pass_result: bool) -> dict:
        self._percent = 100.0
        if pass_result:
            self._message = "Done"
            logger.info("NVMe self-test on %s completed: %s", device, result_string)
            return {"device": device, "test_type": self.test_type.value, "result": result_string}
        self._message = "Failed"
        raise RuntimeError(f"NVMe self-test ended: {result_string}")

    def _nvme_status(self, data: dict) -> tuple[bool, bool, str]:
        """Parse nvme_self_test_log for current status.

        Returns (done, passed, result_string). When not done, updates
        self._percent and self._message as a side effect.
        """
        log = data.get("nvme_self_test_log", {})
        op_value = log.get("current_self_test_operation", {}).get("value", _NVME_OP_NONE)
        if op_value != _NVME_OP_NONE:
            pct = log.get("current_self_test_completion_percent")
            self._percent = float(pct) if pct is not None else None
            op_str = log.get("current_self_test_operation", {}).get("string", "In progress")
            self._message = op_str
            return False, False, ""

        # No test in progress — read the most recent log entry for the result.
        table = log.get("table", [])
        if not table:
            return True, False, "Unknown (no log entry)"
        entry = table[0]
        result_value = entry.get("self_test_result", {}).get("value", -1)
        result_string = entry.get("self_test_result", {}).get("string", "Unknown")
        passed = (result_value == _NVME_RESULT_PASS)
        return True, passed, result_string

    def _extract_start_hours(self, data: dict) -> int | None:
        table = data.get("nvme_self_test_log", {}).get("table", [])
        if table:
            return table[0].get("power_on_hours")
        return None

    def _in_progress_status(self, data: dict) -> tuple[bool, int | None]:
        log = data.get("nvme_self_test_log", {})
        op_value = log.get("current_self_test_operation", {}).get("value", _NVME_OP_NONE)
        if op_value == _NVME_OP_NONE:
            return False, None
        poh = log.get("table", [{}])[0].get("power_on_hours") if log.get("table") else None
        return True, poh

    def _find_completed_result(self, data: dict, poh_expected: int) -> str | None:
        table = data.get("nvme_self_test_log", {}).get("table", [])
        for entry in table:
            if entry.get("power_on_hours") == poh_expected:
                return entry.get("self_test_result", {}).get("string", "Unknown")
        return None

    def get_reattach_data(self) -> dict | None:
        if self._start_hours is None or self._device is None:
            return None
        return {
            "device": self._device,
            "access_type": self._access_type,
            "test_type": self.test_type.value,
            "start_hours": self._start_hours,
        }

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
