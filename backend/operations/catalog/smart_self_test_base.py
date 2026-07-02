"""
operations.catalog.smart_self_test_base — Shared logic for SMART self-tests.

`test_type` is left as an abstract property, so this class still has an
unimplemented abstractmethod and operation_registry.discover() skips it via
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

Restart reattachment
--------------------
The actual self-test runs on the drive's own firmware — there is no OS process
to track.  After a backend restart we re-query `smartctl -a` and correlate the
in-progress (or just-finished) test against the *power-on-hours* value stamped
by the drive in the self-test log at the time the test started.  This guards
against misattributing a completely different test (started by the user or
another tool while the backend was down) to the old DriveCheck job.

Three reattach outcomes:
  1. Test still in progress + hours match → resume polling.
  2. No test in progress, log entry's hours match → test finished during
     downtime; recover the pass/fail result from the log entry.
  3. Hours don't match (or nothing found) → mark job INTERRUPTED.
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
        self._start_hours: int | None = None    # power-on-hours at test start (for reattach)
        self._device: str | None = None
        self._access_type: str | None = None
        self._drive_type: DriveType | None = None

    @staticmethod
    def supports(context: DriveContext) -> bool:
        return context.traits.drive_type in (DriveType.HDD, DriveType.SSD, DriveType.SAS)

    def run(self, context: DriveContext, params: dict) -> dict:
        if self._cancel_event.is_set():
            raise OperationCancelled()

        device = context.descriptor.device_name
        access_type = context.descriptor.access_type
        drive_type = context.traits.drive_type

        self._device = device
        self._access_type = access_type
        self._drive_type = drive_type

        self._message = "Starting"
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
        self._start_hours = self._extract_start_hours(initial_data, drive_type)
        if self._start_hours is not None:
            self._save_reattach()

        return self._poll_until_done(
            device, access_type, drive_type,
            capture_start_hours=(self._start_hours is None),
        )

    def reattach(self, context: DriveContext, params: dict, reattach_data: dict) -> dict:
        device = context.descriptor.device_name
        access_type = context.descriptor.access_type
        drive_type = context.traits.drive_type
        poh_expected = reattach_data.get("start_hours")

        if poh_expected is None:
            raise ReattachFailed("power-on-hours not captured before restart — cannot confirm which self-test to resume")

        self._device = device
        self._access_type = access_type
        self._drive_type = drive_type
        self._message = "Checking"
        logger.info("reattaching to self-test on %s (expected start hours: %s)", device, poh_expected)

        with ProbeTimeout(_SMARTCTL_CALL_TIMEOUT_SECONDS):
            data = smartctl.attributes_all(device, access_type)

        # Check if a test is currently in progress.
        in_progress, current_poh = self._in_progress_status(data, drive_type)
        if in_progress:
            # current_poh comes from table[0].lifetime_hours, which ATA drives report
            # as 0 ("NOW") while a test is running — the real value isn't stamped until
            # the test completes.  If current_poh is a real non-zero value that doesn't
            # match, a different test is definitely running; if it's 0/None we can't
            # verify but accept it rather than failing a valid reattach.
            if current_poh and current_poh != poh_expected:
                raise ReattachFailed(
                    f"a different self-test is now in progress on {device} "
                    f"(expected start hours {poh_expected}, found {current_poh})"
                )
            # Our test is still running (or hours unverifiable but plausible).
            self._start_hours = poh_expected
            logger.info("reattached to in-progress self-test on %s", device)
            return self._poll_until_done(device, access_type, drive_type, capture_start_hours=False)

        # No test in progress — check the log for a recently-finished entry that matches.
        result_string = self._find_completed_result(data, drive_type, poh_expected)
        if result_string is not None:
            logger.info("self-test on %s finished during downtime: %s", device, result_string)
            return self._finalize(device, result_string)

        raise ReattachFailed(
            f"could not confirm previous self-test on {device} — it may have completed, "
            "been aborted, or been replaced by a different test while the backend was down"
        )

    def _poll_until_done(
        self,
        device: str,
        access_type: str,
        drive_type: DriveType,
        capture_start_hours: bool,
    ) -> dict:
        """Poll smartctl until the self-test reaches a terminal state."""
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
                self._start_hours = self._extract_start_hours(data, drive_type)
                self._save_reattach()
                first_poll = False

            result_string = self._scsi_status(data) if drive_type == DriveType.SAS else self._ata_status(data)
            if result_string is None:
                logger.debug("self-test poll for %s: percent=%s message=%s", device, self._percent, self._message)
                continue  # still running; self._percent/_message already updated

            return self._finalize(device, result_string)

    def _finalize(self, device: str, result_string: str) -> dict:
        """Set terminal progress state and return the result dict (or raise on failure)."""
        self._percent = 100.0
        if "without error" in result_string.lower() or result_string == "Completed":
            self._message = "Done"
            logger.info("self-test on %s completed: %s", device, result_string)
            return {"device": device, "test_type": self.test_type.value, "result": result_string}
        self._message = "Failed"
        raise RuntimeError(f"self-test ended: {result_string}")

    # ------------------------------------------------------------------
    # Live-status parsing (used by the poll loop)
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Reattach helpers
    # ------------------------------------------------------------------

    def _extract_start_hours(self, data: dict, drive_type: DriveType) -> int | None:
        """Read the current power-on-hours to use as a reattach discriminator.

        For ATA drives, the self-test log entry shows "NOW" (JSON: lifetime_hours=0)
        while the test is in progress — the actual hour value is only stamped once
        the test completes.  Using the top-level power_on_time.hours avoids that
        problem: it's always populated and equals what the completed log entry will
        show for lifetime_hours (the drive uses the same moment's hours for both).
        """
        return data.get("power_on_time", {}).get("hours")

    def _in_progress_status(self, data: dict, drive_type: DriveType) -> tuple[bool, int | None]:
        """Return (in_progress, current_start_hours) for the current drive state."""
        if drive_type == DriveType.SAS:
            entry = data.get("scsi_self_test_0", {})
            if entry.get("self_test_in_progress"):
                poh = entry.get("power_on_time", {}).get("hours")
                return True, poh
            return False, None
        # ATA
        remaining = (
            data.get("ata_smart_data", {})
            .get("self_test", {})
            .get("status", {})
            .get("remaining_percent")
        )
        if remaining is not None:
            table = data.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])
            poh = table[0].get("lifetime_hours") if table else None
            return True, poh
        return False, None

    def _find_completed_result(self, data: dict, drive_type: DriveType, poh_expected: int) -> str | None:
        """Check the self-test log for a completed entry whose start-hours match poh_expected.

        Returns the result string if a match is found, or None if no matching entry exists.
        """
        if drive_type == DriveType.SAS:
            entry = data.get("scsi_self_test_0", {})
            poh = entry.get("power_on_time", {}).get("hours")
            if poh == poh_expected:
                return entry.get("result", {}).get("string", "Unknown")
            return None
        # ATA: scan the self-test log table for an entry whose lifetime_hours matches
        table = data.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])
        for entry in table:
            if entry.get("lifetime_hours") == poh_expected:
                status_info = entry.get("status", {})
                return status_info.get("string", "Unknown")
        return None

    def get_reattach_data(self) -> dict | None:
        if self._start_hours is None:
            return None
        return {"start_hours": self._start_hours}

    def get_progress(self) -> OperationProgress:
        return OperationProgress(percent=self._percent, message=self._message)

    def cancel(self) -> None:
        self._cancel_event.set()
