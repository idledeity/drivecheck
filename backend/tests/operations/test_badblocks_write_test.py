"""Pass/fail verdicts for the badblocks write test.

The verdict comes from badblocks' whole log file. The "reattached" cases run
_watch_and_wait with no Popen object and an already-exited PID, the same state
a job is in when the backend restarted mid-run and then saw badblocks exit.
"""

import signal
import subprocess
from pathlib import Path

import pytest

from drives.drive_models import DriveContext, DriveDescriptor
from operations import logged_process
from operations.catalog import badblocks_write_test
from operations.catalog.badblocks_write_test import BadblocksWriteTestOperation, _read_badblocks_outcome
from operations.operation import ReattachFailed

DEVICE = "/dev/sdz"

# Real stderr of `badblocks -w -s -v -b 4096 -c 1024 -p 1` (e2fsprogs) on a
# 300 MB file, slowed so progress lines appear. Test logs are cut from it so
# their format can't drift from what badblocks actually prints.
REAL_LOG = (Path(__file__).parent / "fixtures" / "badblocks_w_s_v_one_clean_pass.log").read_bytes()
_FIRST_PHASE = REAL_LOG.index(b"Testing with pattern 0xaa:")
_SUMMARY = REAL_LOG.index(b"Pass completed,")
HEADER = REAL_LOG[:_FIRST_PHASE]
_PHASES = REAL_LOG[_FIRST_PHASE:_SUMMARY]   # 4 patterns × (write + read/compare)


def _pattern(name: str) -> bytes:
    """One pattern's write + read/compare phases, as badblocks printed them."""
    start = _PHASES.index(f"Testing with pattern {name}:".encode())
    nxt = _PHASES.find(b"Testing with pattern", start + 1)
    return _PHASES[start:nxt if nxt != -1 else len(_PHASES)]


def _pass(bad: int) -> bytes:
    """A full pass ending in badblocks' -v summary line (format from the real log)."""
    return _PHASES + f"Pass completed, {bad} bad blocks found. (0/0/{bad} errors)\n".encode()


def _write_log(tmp_path, data: bytes):
    path = tmp_path / "job.log"
    path.write_bytes(data)
    return path


def _reattached(log_path, passes=1):
    proc = subprocess.Popen(["true"])
    proc.wait()
    op = BadblocksWriteTestOperation()
    op._proc = None
    op._pid = proc.pid
    op._device = DEVICE
    op._log_path = log_path
    op._passes = passes
    return op


# ---------------------------------------------------------------------------
# _read_badblocks_outcome
# ---------------------------------------------------------------------------

def test_outcome_counts_passes_and_sums_bad_blocks(tmp_path):
    path = _write_log(tmp_path, HEADER + _pass(3) + _pass(0))
    assert _read_badblocks_outcome(path) == (2, 3)


def test_outcome_no_completed_pass(tmp_path):
    path = _write_log(tmp_path, HEADER + _pattern("0xaa"))
    assert _read_badblocks_outcome(path) == (0, 0)


def test_outcome_counts_summary_split_across_chunks_exactly_once(tmp_path, monkeypatch):
    data = HEADER + _pass(2) + _pass(1)
    path = _write_log(tmp_path, data)
    real_open = open

    class _SmallReads:
        def __init__(self, f):
            self._f = f

        def read(self, _n):
            return self._f.read(7)  # forces "Pass completed" lines across chunk edges

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self._f.close()

    monkeypatch.setattr(badblocks_write_test, "open", lambda p, m: _SmallReads(real_open(p, m)), raising=False)
    assert _read_badblocks_outcome(path) == (2, 3)


def test_outcome_missing_log(tmp_path):
    assert _read_badblocks_outcome(tmp_path / "nope.log") == (0, 0)


# ---------------------------------------------------------------------------
# Reattached runs — the false-pass scenarios
# ---------------------------------------------------------------------------

def test_reattached_killed_mid_pass_fails(tmp_path):
    op = _reattached(_write_log(tmp_path, HEADER + _pattern("0xaa")))
    with pytest.raises(RuntimeError, match="0 of 1 pass"):
        op._watch_and_wait()
    assert op.get_progress().message == "Failed"


def test_reattached_bad_blocks_from_before_restart_still_fail(tmp_path):
    # Pass 1 found bad blocks before the restart; badblocks then ran a clean
    # pass 2 after it. Only the clean pass is in the tail we watched.
    log = HEADER + _pass(5)
    path = _write_log(tmp_path, log)
    op = _reattached(path)
    with open(path, "ab") as f:
        f.write(_pass(0))
    with pytest.raises(RuntimeError, match="5 bad block"):
        op._watch_and_wait(start_offset=len(log))


def test_reattached_run_that_finished_clean_passes(tmp_path):
    op = _reattached(_write_log(tmp_path, HEADER + _pass(0)))
    result = op._watch_and_wait()
    assert result == {"device": DEVICE, "bad_blocks": 0, "passes": 1}
    assert op.get_progress().message == "Done"


def test_requested_passes_must_all_complete(tmp_path):
    op = _reattached(_write_log(tmp_path, HEADER + _pass(0)), passes=2)
    with pytest.raises(RuntimeError, match="1 of 2 pass"):
        op._watch_and_wait()


# ---------------------------------------------------------------------------
# Finished while the backend was down — reattach() finds the process gone
# ---------------------------------------------------------------------------

_CONTEXT = DriveContext(guid="g", descriptor=DriveDescriptor(device_name=DEVICE, access_type="sat", info_name=DEVICE))
_PARAMS = {"block_size": 4096, "passes": 1}


def _reattach_data(log_path):
    proc = subprocess.Popen(["true"])
    proc.wait()
    return {"pid": proc.pid, "log_path": str(log_path), "device": DEVICE}


def test_finished_clean_during_downtime_recovers_pass(tmp_path):
    op = BadblocksWriteTestOperation()
    result = op.reattach(_CONTEXT, _PARAMS, _reattach_data(_write_log(tmp_path, HEADER + _pass(0))))
    assert result == {"device": DEVICE, "bad_blocks": 0, "passes": 1}
    assert op.get_progress().message == "Done"


def test_bad_blocks_found_before_downtime_kill_still_fails(tmp_path):
    # Pass 1 reported bad blocks; badblocks was then killed during its repeat pass.
    log = _write_log(tmp_path, HEADER + _pass(4) + _pattern("0xaa"))
    with pytest.raises(RuntimeError, match="4 bad block"):
        BadblocksWriteTestOperation().reattach(_CONTEXT, _PARAMS, _reattach_data(log))


def test_killed_mid_pass_during_downtime_stays_interrupted(tmp_path):
    log = _write_log(tmp_path, HEADER + _pattern("0xaa"))
    with pytest.raises(ReattachFailed, match="stopped before finishing"):
        BadblocksWriteTestOperation().reattach(_CONTEXT, _PARAMS, _reattach_data(log))


# ---------------------------------------------------------------------------
# A real badblocks run on a small file
# ---------------------------------------------------------------------------

def test_real_badblocks_run_on_a_clean_file_passes(tmp_path, monkeypatch):
    # Catches command-line problems the canned logs can't: before -v was added,
    # badblocks never printed its pass summary and a clean drive failed.
    monkeypatch.setattr(logged_process, "is_device_mounted", lambda _d: False)
    img = tmp_path / "drive.img"
    img.write_bytes(b"\x00" * (4 * 1024 * 1024))
    context = DriveContext(guid="g", descriptor=DriveDescriptor(str(img), "sat", str(img)))

    def _timeout(_signum, _frame):
        raise TimeoutError("badblocks run did not finish")

    previous = signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(30)
    try:
        result = BadblocksWriteTestOperation().run(context, _PARAMS)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
    assert result == {"device": str(img), "bad_blocks": 0, "passes": 1}


# ---------------------------------------------------------------------------
# Progress — fed the real log, so the phase structure is badblocks' own
# ---------------------------------------------------------------------------

# Log up to "25.33% done" in the 0x55 write phase (the 3rd of 8 phases).
_P55 = _pattern("0x55")
MID_0X55_WRITE = HEADER + _pattern("0xaa") + _P55[:_P55.index(b"25.33% done") + len(b"25.33% done")]

def _progress_while_feeding(op, data: bytes, chunk_size: int) -> list[float]:
    seen = []
    for i in range(0, len(data), chunk_size):
        op._on_log_bytes(data[i:i + chunk_size])
        if op._percent is not None:
            seen.append(op._percent)
    return seen


def test_progress_rises_steadily_through_all_eight_phases():
    op = BadblocksWriteTestOperation()
    seen = _progress_while_feeding(op, REAL_LOG, chunk_size=40)
    assert seen == sorted(seen), "progress went backwards"
    assert seen[-1] > 85  # last phase reached 94.67%: (7 * 100 + 94.67) / 8
    assert seen[-1] <= 99.0
    assert op._phases_started == 8


def test_progress_is_the_same_however_the_log_is_chunked():
    whole = BadblocksWriteTestOperation()
    whole._on_log_bytes(REAL_LOG)
    bytewise = BadblocksWriteTestOperation()
    _progress_while_feeding(bytewise, REAL_LOG, chunk_size=1)
    assert (bytewise._percent, bytewise._message) == (whole._percent, whole._message)


def test_progress_message_names_pass_pattern_and_phase():
    op = BadblocksWriteTestOperation()
    op._on_log_bytes(MID_0X55_WRITE)
    # 0x55's write phase is the 3rd phase: 2 done + 25.33% of the 3rd, over 8.
    assert op._message == "pass 1/1 · 0x55 write · 25.3%"
    assert op._percent == round((2 * 100 + 25.33) / 8, 1)


def test_progress_counts_across_passes():
    op = BadblocksWriteTestOperation()
    op._passes = 2
    op._on_log_bytes(HEADER + _pass(0) + _pattern("0xaa")[:200])
    assert op._message.startswith("pass 2/2 · 0xaa write")
    assert 50 <= op._percent < 60


def test_progress_marks_repeat_passes_and_stays_below_100():
    op = BadblocksWriteTestOperation()
    op._on_log_bytes(HEADER + _pass(3) + _pass(0))  # -p 1 repeated after finding bad blocks
    assert op._message.startswith("pass 2 (repeat after bad blocks)")
    assert op._percent == 99.0


def test_reattach_rebuilds_progress_from_the_whole_log(tmp_path):
    path = _write_log(tmp_path, MID_0X55_WRITE)
    op = BadblocksWriteTestOperation()
    op._log_path = path
    op._restore_reattach_data({})
    assert op._message == "pass 1/1 · 0x55 write · 25.3%"
