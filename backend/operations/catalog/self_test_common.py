"""
operations.catalog.self_test_common — What every drive self-test shares.

ATA/SAS (smart_self_test_base) and NVMe (nvme_self_test_base) self-tests read
progress and results from different parts of smartctl's output, so starting,
polling and reattaching stay in those modules. Common to both: the test runs
on the drive's firmware, is started and aborted through smartctl, is cancelled
by an event the poll loop waits on, and ends with the drive's own result
string.

`test_type` is left abstract, so operation_registry.discover() skips this
class and the two bases that extend it (inspect.isabstract()).
"""

import threading
from abc import abstractmethod

from drives.tools.smartctl import SelfTestType
from operations.operation import OperationBase, OperationProgress


class SelfTestOperation(OperationBase):
    """A self-test run by the drive's firmware and polled through smartctl."""

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
        self._start_hours: int | None = None    # power-on-hours at test start (for reattach)
        self._device: str | None = None
        self._access_type: str | None = None

    @classmethod
    def summarize(cls, result: dict) -> str | None:
        # Drives word it differently: "Completed" (SAS), "completed without error" (ATA).
        text = result["result"]
        return f"Self-test: {text[:1].upper()}{text[1:]}"

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
