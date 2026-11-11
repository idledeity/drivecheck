"""Pass/fail verdicts for the badblocks write test.

The verdict comes from badblocks' whole log file. The "reattached" cases run
_watch_and_wait with no Popen object and an already-exited PID, the same state
a job is in when the backend restarted mid-run and then saw badblocks exit.
"""

import subprocess

import pytest

from operations.catalog import badblocks_write_test
from operations.catalog.badblocks_write_test import BadblocksWriteTestOperation, _read_badblocks_outcome

DEVICE = "/dev/sdz"
BS = b"\b" * 40


def _pattern(name: str, pct_steps=(10.0, 55.5, 99.99)) -> bytes:
    out = f"Testing with pattern {name}: ".encode()
    for pct in pct_steps:
        out += f"{pct:.2f}% done, 0:01 elapsed. (0/0/0 errors)".encode() + BS
    out += b"done                                                 \nReading and comparing: "
    for pct in pct_steps:
        out += f"{pct:.2f}% done, 0:02 elapsed. (0/0/0 errors)".encode() + BS
    return out + b"done                                                 \n"


def _pass(bad: int) -> bytes:
    body = b"".join(_pattern(p) for p in ("0xaa", "0x55", "0xff", "0x00"))
    return body + f"Pass completed, {bad} bad blocks found. ({bad}/0/0 errors)\n".encode()


HEADER = b"Checking for bad blocks in read-write mode\nFrom block 0 to 1465130645\n"


def _write_log(tmp_path, data: bytes):
    path = tmp_path / "job.log"
    path.write_bytes(data)
    return path


def _reattached(log_path, patterns_done=0):
    proc = subprocess.Popen(["true"])
    proc.wait()
    op = BadblocksWriteTestOperation()
    op._proc = None
    op._pid = proc.pid
    op._device = DEVICE
    op._log_path = log_path
    op._patterns_done = patterns_done
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
        op._watch_and_wait(passes=1)
    assert op.get_progress().message == "Failed"


def test_reattached_bad_blocks_from_before_restart_still_fail(tmp_path):
    # Pass 1 found bad blocks before the restart; badblocks then ran a clean
    # pass 2 after it. Only the clean pass is in the tail we watched.
    log = HEADER + _pass(5)
    path = _write_log(tmp_path, log)
    op = _reattached(path, patterns_done=4)
    with open(path, "ab") as f:
        f.write(_pass(0))
    with pytest.raises(RuntimeError, match="5 bad block"):
        op._watch_and_wait(passes=1, start_offset=len(log))


def test_reattached_run_that_finished_clean_passes(tmp_path):
    op = _reattached(_write_log(tmp_path, HEADER + _pass(0)))
    result = op._watch_and_wait(passes=1)
    assert result == {"device": DEVICE, "bad_blocks": 0, "passes": 1}
    assert op.get_progress().message == "Done"


def test_requested_passes_must_all_complete(tmp_path):
    op = _reattached(_write_log(tmp_path, HEADER + _pass(0)))
    with pytest.raises(RuntimeError, match="1 of 2 pass"):
        op._watch_and_wait(passes=2)
