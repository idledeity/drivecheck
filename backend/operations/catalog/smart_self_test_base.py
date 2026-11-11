"""
operations.catalog.smart_self_test_base — The self-test procedure for every drive.

ATA, SCSI/SAS and NVMe self-tests are all started with `smartctl -t`, aborted
with `smartctl -X` and polled with `smartctl -a -j`; only where that JSON
reports progress and results differs. That reading is done by the per-interface
readers in smart_self_test_readers, picked from the drive type, so this one
class runs the whole procedure for all of them.

`test_type` is left as an abstract property, so this class still has an
unimplemented abstractmethod and operation_registry.discover() skips it via
inspect.isabstract(), even though it lives in operations/catalog alongside the
concrete short/long/conveyance operations that subclass it and set `test_type`.

Result attribution
------------------
Right after the start, a drive may still report the previous test's result.
A finished-looking status is only accepted with proof that it belongs to this
job's test: the test was seen running, or the self-test log gained an entry
since the start.

Restart reattachment
--------------------
The actual self-test runs on the drive's own firmware — there is no OS process
to track.  After a backend restart we re-query `smartctl -a` and correlate the
in-progress (or just-finished) test against the *power-on-hours* recorded when
the test started.  This guards against misattributing a completely different
test (started by the user or another tool while the backend was down) to the
old DriveCheck job.

Three reattach outcomes:
  1. Test still in progress + hours match → resume polling.
  2. No test in progress, log entry's hours match → test finished during
     downtime; recover the pass/fail result from the log entry.
  3. Hours don't match (or nothing found) → mark job INTERRUPTED.
"""

import logging
import threading
from abc import abstractmethod

from drives.drive_models import DriveContext
from drives.tools import smartctl
from drives.tools.smartctl import SelfTestType
from drives.tools.timeout import ProbeTimeout
from operations.catalog.smart_self_test_readers import Finished, Running, SelfTestReader, reader_for
from operations.operation import OperationBase, OperationCancelled, OperationProgress, ReattachFailed

logger = logging.getLogger(__name__)

_POLL_INTERVAL_SECONDS = 30
_SMARTCTL_CALL_TIMEOUT_SECONDS = 30
# How many polls a finished-looking status may go unconfirmed (test never seen
# running, no new self-test log entry) before the job fails rather than passes.
_UNCONFIRMED_POLL_LIMIT = 10


def _log_has_new_entry(before: list[dict], after: list[dict]) -> bool:
    """True if the self-test log gained an entry since `before` was read.

    Entries carry no unique id and the log can hold identical rows (same type,
    result and hour), so a new entry is seen as the log growing, or, once the
    log is full and rotating, as its contents changing.
    """
    if len(after) > len(before):
        return True
    return len(after) == len(before) and after != before


class SmartSelfTestOperation(OperationBase):
    """Starts a drive self-test and polls smartctl until it finishes."""

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
        self._reader: SelfTestReader | None = None
        # Evidence that the result we read belongs to this job's test, not an
        # earlier one: we saw it running, or the log gained an entry since start.
        self._seen_running = False
        self._log_before_start: list[dict] = []

    @classmethod
    def supports(cls, context: DriveContext) -> bool:
        reader = reader_for(context.traits.drive_type)
        return reader is not None and cls.test_type in reader.test_types

    @classmethod
    def summarize(cls, result: dict) -> str | None:
        text = result["result"]
        return f"Self-test: {text[:1].upper()}{text[1:]}"

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        access_type = context.descriptor.access_type
        reader = self._use_reader(context)

        self._message = "Starting"
        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            self._log_before_start = reader.log(smartctl.attributes_all(device, access_type))
        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            start_result = smartctl.self_test_start(device, access_type, self.test_type)
        if not start_result.success:
            self._message = "Failed"
            raise RuntimeError(start_result.message or "smartctl failed to start self-test")

        # Try to capture start_hours immediately so reattach works even within
        # the first 30-second poll interval.  Some drives take a moment to
        # update their self-test log after the test starts, so if the hours
        # aren't visible yet we fall back to capturing on the first poll.
        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            initial_data = smartctl.attributes_all(device, access_type)
        self._seen_running = isinstance(reader.status(initial_data), Running)
        self._start_hours = reader.start_hours(initial_data)
        if self._start_hours is not None:
            self._save_reattach()

        return self._poll_until_done(device, access_type, capture_start_hours=self._start_hours is None)

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        device = context.descriptor.device_name
        access_type = context.descriptor.access_type
        reader = self._use_reader(context)
        poh_expected = reattach_data.get("start_hours")

        if poh_expected is None:
            raise ReattachFailed("power-on-hours not captured before restart — cannot confirm which self-test to resume")

        self._message = "Checking"
        logger.info("reattaching to self-test on %s (expected start hours: %s)", device, poh_expected)

        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            data = smartctl.attributes_all(device, access_type)

        if isinstance(reader.status(data), Running):
            # A real non-zero value that doesn't match means a different test is
            # running; 0/None can't be verified but is accepted rather than
            # failing a valid reattach (see SelfTestReader.running_hours).
            current_poh = reader.running_hours(data)
            if current_poh and current_poh != poh_expected:
                raise ReattachFailed(
                    f"a different self-test is now in progress on {device} "
                    f"(expected start hours {poh_expected}, found {current_poh})"
                )
            self._start_hours = poh_expected
            self._seen_running = True
            logger.info("reattached to in-progress self-test on %s", device)
            return self._poll_until_done(device, access_type, capture_start_hours=False)

        finished = reader.completed_at(data, poh_expected)
        if finished is not None:
            logger.info("self-test on %s finished during downtime: %s", device, finished.result)
            return self._finalize(device, finished)

        raise ReattachFailed(
            f"could not confirm previous self-test on {device} — it may have completed, "
            "been aborted, or been replaced by a different test while the backend was down"
        )

    def _use_reader(self, context: DriveContext) -> SelfTestReader:
        reader = reader_for(context.traits.drive_type)
        if reader is None:  # supports() keeps these drives from getting the job
            raise RuntimeError(f"no self-test support for {context.traits.drive_type} drives")
        self._reader = reader
        return reader

    def _poll_until_done(self, device: str, access_type: str, capture_start_hours: bool) -> dict:
        """Poll smartctl until the self-test reaches a terminal state."""
        reader = self._reader
        first_poll = True
        unconfirmed_polls = 0
        while True:
            if self._cancel_event.wait(_POLL_INTERVAL_SECONDS):
                with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
                    smartctl.self_test_abort(device, access_type)
                self._message = "Cancelled"
                raise OperationCancelled()

            with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
                data = smartctl.attributes_all(device, access_type)

            if first_poll and capture_start_hours:
                self._start_hours = reader.start_hours(data)
                self._save_reattach()
                first_poll = False

            status = reader.status(data)
            if isinstance(status, Running):
                self._percent, self._message = status.percent, status.message
                self._seen_running = True
                logger.debug("self-test poll for %s: percent=%s message=%s", device, self._percent, self._message)
                continue

            # A finished-looking status may still be the previous test's result
            # if the drive hasn't registered ours yet — only accept it with proof.
            if not self._seen_running and not _log_has_new_entry(self._log_before_start, reader.log(data)):
                unconfirmed_polls += 1
                if unconfirmed_polls >= _UNCONFIRMED_POLL_LIMIT:
                    self._message = "Failed"
                    raise RuntimeError(
                        f"could not confirm the self-test ran on {device}: it was never reported "
                        f"in progress and no new self-test log entry appeared (status: {status.result})"
                    )
                self._message = "Waiting for the drive to report the test"
                continue

            return self._finalize(device, status)

    def _finalize(self, device: str, finished: Finished) -> dict:
        """Set terminal progress state and return the result dict (or raise on failure)."""
        self._percent = 100.0
        if finished.passed:
            self._message = "Done"
            logger.info("self-test on %s completed: %s", device, finished.result)
            return {"device": device, "test_type": self.test_type.value, "result": finished.result}
        self._message = "Failed"
        raise RuntimeError(f"self-test ended: {finished.result}")

    def get_reattach_data(self) -> dict | None:
        if self._start_hours is None:
            return None
        return {"start_hours": self._start_hours}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
