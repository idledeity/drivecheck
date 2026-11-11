"""Pass/fail verdicts for the dd read and write tests.

The verdict comes from dd's whole log file, so these tests write realistic logs
and check the result. The "reattached" cases run _watch_and_wait with no Popen
object and an already-exited PID, the same state a job is in when the backend
restarted mid-run and then saw the dd process exit.
"""

import subprocess

import pytest

from drives.drive_models import DriveContext, DriveDescriptor, DriveTraits
from operations.catalog import dd_write_test
from operations.catalog.dd_read_test import (
    DDOutcome,
    DDReadTestOperation,
    _dd_failure,
    _expected_bytes,
    _read_dd_outcome,
)
from operations.catalog.dd_write_test import DDWriteTestOperation

DEVICE = "/dev/sdz"
CAPACITY = 6_001_175_126_016  # not a multiple of 1 MiB, like real drives

PROGRESS = (
    "1048576000 bytes (1.0 GB, 1000 MiB) copied, 5 s, 210 MB/s\r"
    "2097152000 bytes (2.1 GB, 2.0 GiB) copied, 10 s, 210 MB/s\r"
)


def _summary(nbytes: int) -> str:
    return f"\n5723166+1 records in\n5723166+1 records out\n{nbytes} bytes (6.0 TB, 5.5 TiB) copied, 34786.1 s, 173 MB/s\n"


def _dead_pid() -> int:
    proc = subprocess.Popen(["true"])
    proc.wait()
    return proc.pid


def _write_log(tmp_path, text: str):
    path = tmp_path / "job.log"
    path.write_text(text)
    return path


def _reattached(op, log_path):
    op._proc = None
    op._pid = _dead_pid()
    op._device = DEVICE
    op._log_path = log_path
    return op


# ---------------------------------------------------------------------------
# _expected_bytes
# ---------------------------------------------------------------------------

def test_expected_bytes_whole_device_from_skip_offset():
    assert _expected_bytes(1048576, 0, 0, CAPACITY) == CAPACITY
    assert _expected_bytes(1048576, 0, 10, CAPACITY) == CAPACITY - 10 * 1048576


def test_expected_bytes_count_is_clipped_to_device_end():
    assert _expected_bytes(4096, 100, 0, CAPACITY) == 409600
    assert _expected_bytes(4096, 100, 0, 4096 * 50) == 4096 * 50


def test_expected_bytes_unknown_capacity():
    assert _expected_bytes(4096, 0, 0, None) is None
    assert _expected_bytes(4096, 100, 0, None) == 409600


# ---------------------------------------------------------------------------
# _read_dd_outcome
# ---------------------------------------------------------------------------

def test_outcome_completed_run_uses_final_summary_bytes(tmp_path):
    outcome = _read_dd_outcome(_write_log(tmp_path, PROGRESS + _summary(CAPACITY)))
    assert outcome == DDOutcome(completed=True, bytes_copied=CAPACITY, errors=[])


def test_outcome_killed_run_has_only_progress_lines(tmp_path):
    outcome = _read_dd_outcome(_write_log(tmp_path, PROGRESS))
    assert outcome.completed is False
    assert outcome.bytes_copied is None


def test_outcome_collects_error_lines_but_not_warnings(tmp_path):
    log = (
        PROGRESS
        + "dd: error reading '/dev/sdz': Input/output error\n"
        + "dd: warning: partial read (512 bytes); suggest iflag=fullblock\n"
        + _summary(CAPACITY)
    )
    outcome = _read_dd_outcome(_write_log(tmp_path, log))
    assert outcome.errors == ["dd: error reading '/dev/sdz': Input/output error"]


def test_outcome_missing_log_is_not_completed(tmp_path):
    assert _read_dd_outcome(tmp_path / "nope.log").completed is False


# ---------------------------------------------------------------------------
# _dd_failure
# ---------------------------------------------------------------------------

def test_failure_none_for_clean_complete_run():
    assert _dd_failure(DDOutcome(True, CAPACITY, []), 0, CAPACITY) is None
    assert _dd_failure(DDOutcome(True, CAPACITY, []), None, CAPACITY) is None


def test_failure_on_any_error_line_even_with_exit_zero():
    errors = ["dd: error reading '/dev/sdz': Input/output error"] * 3
    failure = _dd_failure(DDOutcome(True, CAPACITY, errors), 0, CAPACITY)
    assert failure == "dd: error reading '/dev/sdz': Input/output error (+2 more)"


def test_failure_on_nonzero_exit():
    assert _dd_failure(DDOutcome(True, CAPACITY, []), 1, CAPACITY) == "dd exited with code 1"


def test_failure_when_no_summary_after_reattach():
    failure = _dd_failure(DDOutcome(False, None, []), None, CAPACITY)
    assert failure is not None and "did not finish" in failure


def test_failure_on_short_copy():
    failure = _dd_failure(DDOutcome(True, 1000, []), 0, CAPACITY)
    assert failure == f"dd stopped early: 1000 of {CAPACITY} bytes copied"


def test_unknown_expected_bytes_skips_length_check():
    assert _dd_failure(DDOutcome(True, 1000, []), 0, None) is None


# ---------------------------------------------------------------------------
# Reattached runs — the false-pass scenario
# ---------------------------------------------------------------------------

def test_reattached_read_killed_mid_run_fails(tmp_path):
    op = _reattached(DDReadTestOperation(), _write_log(tmp_path, PROGRESS))
    with pytest.raises(RuntimeError, match="did not finish"):
        op._watch_and_wait(CAPACITY)
    assert op.get_progress().message == "Failed"


def test_reattached_read_that_finished_passes(tmp_path):
    op = _reattached(DDReadTestOperation(), _write_log(tmp_path, PROGRESS + _summary(CAPACITY)))
    result = op._watch_and_wait(CAPACITY)
    assert result["bytes_read"] == CAPACITY
    assert op.get_progress().message == "Done"


def test_reattached_write_killed_mid_run_fails(tmp_path):
    op = _reattached(DDWriteTestOperation(), _write_log(tmp_path, PROGRESS))
    with pytest.raises(RuntimeError, match="did not finish"):
        op._watch_and_wait(CAPACITY)


def test_reattached_write_that_finished_passes(tmp_path):
    op = _reattached(DDWriteTestOperation(), _write_log(tmp_path, PROGRESS + _summary(CAPACITY)))
    assert op._watch_and_wait(CAPACITY)["bytes_written"] == CAPACITY


# ---------------------------------------------------------------------------
# Write test command line
# ---------------------------------------------------------------------------

_WRITE_PARAMS = {"block_size": 1048576, "count": 0, "skip": 0, "conv_fsync": True, "oflag_direct": False}


def _context(capacity):
    return DriveContext(
        guid="g",
        descriptor=DriveDescriptor(device_name=DEVICE, access_type="sat", info_name=DEVICE),
        traits=DriveTraits(capacity_bytes=capacity),
    )


class _StopAtPopen(Exception):
    pass


def test_write_stops_on_exact_byte_count(monkeypatch):
    captured = {}

    def fake_popen(cmd, **_kwargs):
        captured["cmd"] = cmd
        raise _StopAtPopen()

    monkeypatch.setattr(dd_write_test, "_is_device_mounted", lambda _d: False)
    monkeypatch.setattr(dd_write_test.subprocess, "Popen", fake_popen)
    with pytest.raises(_StopAtPopen):
        DDWriteTestOperation().run(_context(CAPACITY), _WRITE_PARAMS)
    cmd = captured["cmd"]
    assert f"count={CAPACITY}" in cmd
    assert "iflag=count_bytes" in cmd
    assert "conv=fsync" in cmd


def test_write_refuses_whole_device_when_capacity_unknown(monkeypatch):
    monkeypatch.setattr(dd_write_test, "_is_device_mounted", lambda _d: False)
    with pytest.raises(RuntimeError, match="capacity .* is unknown"):
        DDWriteTestOperation().run(_context(None), _WRITE_PARAMS)
