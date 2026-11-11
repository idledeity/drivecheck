"""
operations.catalog.smart_self_test_base — Shared logic for SMART self-tests.

`test_type` (declared on SelfTestOperation) is left as an abstract property,
so this class still has an unimplemented abstractmethod and
operation_registry.discover() skips it via inspect.isabstract() — even though
it lives in operations/catalog alongside the concrete short/long test
operations that subclass it and set `test_type`.

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

from drives.drive_models import DriveContext, DriveType
from drives.tools import smartctl
from drives.tools.timeout import ProbeTimeout
from operations.catalog.self_test_common import SelfTestOperation
from operations.operation import OperationCancelled, ReattachFailed

logger = logging.getLogger(__name__)

_POLL_INTERVAL_SECONDS = 30
_SMARTCTL_CALL_TIMEOUT_SECONDS = 30
# How many polls a finished-looking status may go unconfirmed (test never seen
# running, no new self-test log entry) before the job fails rather than passes.
_UNCONFIRMED_POLL_LIMIT = 10


def _self_test_log(data: dict, drive_type: DriveType) -> list[dict]:
    """The drive's self-test log entries, newest first."""
    if drive_type == DriveType.SAS:
        entries = []
        while (entry := data.get(f"scsi_self_test_{len(entries)}")) is not None:
            entries.append(entry)
        return entries
    return data.get("ata_smart_self_test_log", {}).get("standard", {}).get("table", [])


def _log_has_new_entry(before: list[dict], after: list[dict]) -> bool:
    """True if the self-test log gained an entry since `before` was read.

    Entries carry no unique id and the log can hold identical rows (same type,
    result and hour), so a new entry is seen as the log growing, or, once the
    log is full and rotating, as its contents changing.
    """
    if len(after) > len(before):
        return True
    return len(after) == len(before) and after != before


class SmartSelfTestOperation(SelfTestOperation):
    """Starts a SMART self-test and polls smartctl until it finishes."""

    def __init__(self):
        super().__init__()
        self._drive_type: DriveType | None = None
        # Evidence that the result we read belongs to this job's test, not an
        # earlier one: we saw it running, or the log gained an entry since start.
        self._seen_running = False
        self._log_before_start: list[dict] = []

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
            self._log_before_start = _self_test_log(smartctl.attributes_all(device, access_type), drive_type)
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
        self._seen_running = self._in_progress_status(initial_data, drive_type)[0]
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
            # current_poh comes from the in-progress log entry. Some ATA drives report
            # it as 0 ("NOW") until the test completes; others (seen on a Seagate Exos
            # X16) stamp the real hours at start; SAS entries carry none while running.
            # If it is a real non-zero value that doesn't match, a different test is
            # running; if it's 0/None we can't verify but accept it rather than
            # failing a valid reattach.
            if current_poh and current_poh != poh_expected:
                raise ReattachFailed(
                    f"a different self-test is now in progress on {device} "
                    f"(expected start hours {poh_expected}, found {current_poh})"
                )
            # Our test is still running (or hours unverifiable but plausible).
            self._start_hours = poh_expected
            self._seen_running = True
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
                self._start_hours = self._extract_start_hours(data, drive_type)
                self._save_reattach()
                first_poll = False

            result_string = self._scsi_status(data) if drive_type == DriveType.SAS else self._ata_status(data)
            if result_string is None:
                self._seen_running = True
                logger.debug("self-test poll for %s: percent=%s message=%s", device, self._percent, self._message)
                continue  # still running; self._percent/_message already updated

            # A finished-looking status may still be the previous test's result
            # if the drive hasn't registered ours yet — only accept it with proof.
            if not self._seen_running and not _log_has_new_entry(
                self._log_before_start, _self_test_log(data, drive_type)
            ):
                unconfirmed_polls += 1
                if unconfirmed_polls >= _UNCONFIRMED_POLL_LIMIT:
                    self._message = "Failed"
                    raise RuntimeError(
                        f"could not confirm the self-test ran on {device}: it was never reported "
                        f"in progress and no new self-test log entry appeared (status: {result_string})"
                    )
                self._message = "Waiting for the drive to report the test"
                continue

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

        Some ATA drives show the in-progress log entry as "NOW" (JSON:
        lifetime_hours=0) until the test completes, and SAS in-progress entries
        carry no hours at all, so the log can't be relied on at start. The
        top-level power_on_time.hours is always populated, and on the drives
        observed (SAS and ATA short tests) the completed entry is stamped with
        that same start-time value.
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
