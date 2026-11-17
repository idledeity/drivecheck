"""Pass/fail verdicts for secure erase (shred).

shred prints no completion line; a finished pass that showed progress ends with
"X/X 100%". The logs below are real shred output (coreutils 9.7). The
reattach cases use an already-exited PID, the state a job is in when its
process ended or was killed while the backend was restarting.
"""

import signal
import subprocess

import pytest

from drives.drive_models import DriveContext, DriveDescriptor
from operations import logged_process
from operations.catalog.secure_erase import SecureEraseOperation, _read_shred_outcome
from operations.operation import ReattachFailed

DEVICE = "/dev/sdz"
PARAMS = {"passes": 1, "zero_fill": True}  # 2 passes total
CONTEXT = DriveContext(guid="g", descriptor=DriveDescriptor(device_name=DEVICE, access_type="sat", info_name=DEVICE))

FINISHED = (
    "shred: /dev/sdz: pass 1/2 (random)...\n"
    "shred: /dev/sdz: pass 1/2 (random)...54MiB/400MiB 13%\n"
    "shred: /dev/sdz: pass 1/2 (random)...400MiB/400MiB 100%\n"
    "shred: /dev/sdz: pass 2/2 (000000)...\n"
    "shred: /dev/sdz: pass 2/2 (000000)...208MiB/400MiB 52%\n"
    "shred: /dev/sdz: pass 2/2 (000000)...400MiB/400MiB 100%\n"
)
KILLED_IN_LAST_PASS = FINISHED.rsplit("shred: /dev/sdz: pass 2/2 (000000)...400MiB", 1)[0]
WRITE_ERROR = "shred: /dev/sdz: error writing at offset 1048576: Input/output error\n"


def _write_log(tmp_path, text):
    path = tmp_path / "job.log"
    path.write_text(text)
    return path


def _reattach_data(log_path):
    proc = subprocess.Popen(["true"])
    proc.wait()
    return {"pid": proc.pid, "log_path": str(log_path), "device": DEVICE}


# ---------------------------------------------------------------------------
# _read_shred_outcome
# ---------------------------------------------------------------------------

def test_outcome_finished_needs_last_pass_at_100(tmp_path):
    assert _read_shred_outcome(_write_log(tmp_path, FINISHED), 2) == (True, [])


def test_outcome_first_pass_100_is_not_finished(tmp_path):
    assert _read_shred_outcome(_write_log(tmp_path, KILLED_IN_LAST_PASS), 2) == (False, [])


def test_outcome_collects_error_lines(tmp_path):
    finished, errors = _read_shred_outcome(_write_log(tmp_path, FINISHED + WRITE_ERROR), 2)
    assert errors == [WRITE_ERROR.strip()]


# ---------------------------------------------------------------------------
# Reattached after a restart
# ---------------------------------------------------------------------------

def test_finished_during_downtime_recovers_pass(tmp_path):
    op = SecureEraseOperation()
    result = op.reattach(CONTEXT, PARAMS, _reattach_data(_write_log(tmp_path, FINISHED)))
    assert result == {"device": DEVICE, "total_passes": 2}
    assert op.get_progress().message == "Done"


def test_error_during_downtime_fails(tmp_path):
    log = _write_log(tmp_path, KILLED_IN_LAST_PASS + WRITE_ERROR)
    with pytest.raises(RuntimeError, match="Input/output error"):
        SecureEraseOperation().reattach(CONTEXT, PARAMS, _reattach_data(log))


def test_killed_during_downtime_stays_interrupted(tmp_path):
    log = _write_log(tmp_path, KILLED_IN_LAST_PASS)
    with pytest.raises(ReattachFailed, match="stopped before finishing"):
        SecureEraseOperation().reattach(CONTEXT, PARAMS, _reattach_data(log))


def test_reattached_then_killed_fails_instead_of_passing(tmp_path):
    # Previously: no exit code after reattach was treated as success.
    op = SecureEraseOperation()
    op._proc = None
    op._pid = _reattach_data(tmp_path / "unused")["pid"]
    op._device = DEVICE
    op._log_path = _write_log(tmp_path, KILLED_IN_LAST_PASS)
    op._total_passes = 2
    with pytest.raises(RuntimeError, match="did not finish"):
        op._watch_and_wait()


# ---------------------------------------------------------------------------
# A real run on a small file — too fast to print progress, so the exit code decides
# ---------------------------------------------------------------------------

def test_real_shred_run_on_a_small_file_passes(tmp_path, monkeypatch):
    monkeypatch.setattr(logged_process, "is_device_mounted", lambda _d: False)
    img = tmp_path / "drive.img"
    img.write_bytes(b"\xff" * 1024 * 1024)
    context = DriveContext(guid="g", descriptor=DriveDescriptor(str(img), "sat", str(img)))

    def _timeout(_signum, _frame):
        raise TimeoutError("shred run did not finish")

    previous = signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(10)
    try:
        result = SecureEraseOperation().run(context, PARAMS)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
    assert result == {"device": str(img), "total_passes": 2}
    assert img.read_bytes() == b"\x00" * 1024 * 1024


# ---------------------------------------------------------------------------
# Summary log
# ---------------------------------------------------------------------------

from pathlib import Path  # noqa: E402

from operations.catalog.secure_erase import _summarize_shred_log  # noqa: E402

# Real shred 9.7 output: 1 random pass + zero fill of a 2 GiB file.
REAL_2GIB = (Path(__file__).parent / "fixtures" / "shred_1_pass_zero_2gib.log").read_text()


def _summary(tmp_path, text):
    return list(_summarize_shred_log(_write_log(tmp_path, text)))


def test_summary_keeps_each_pass_last_line(tmp_path):
    assert _summary(tmp_path, REAL_2GIB) == [
        "shred: /var/tmp/shredcap.4hc4/img: pass 1/2 (random)...2.0GiB/2.0GiB 100%",
        "shred: /var/tmp/shredcap.4hc4/img: pass 2/2 (000000)...2.0GiB/2.0GiB 100%",
    ]


def test_summary_of_a_killed_run_shows_how_far_it_got(tmp_path):
    killed = REAL_2GIB.split("shred: /var/tmp/shredcap.4hc4/img: pass 2/2 (000000)...1.5GiB", 1)[0]
    assert _summary(tmp_path, killed)[-1] == "shred: /var/tmp/shredcap.4hc4/img: pass 2/2 (000000)...747MiB/2.0GiB 36%"


def test_summary_keeps_an_error_after_the_progress_it_interrupted(tmp_path):
    assert _summary(tmp_path, KILLED_IN_LAST_PASS + WRITE_ERROR) == [
        "shred: /dev/sdz: pass 1/2 (random)...400MiB/400MiB 100%",
        "shred: /dev/sdz: pass 2/2 (000000)...208MiB/400MiB 52%",
        WRITE_ERROR.strip(),
    ]
