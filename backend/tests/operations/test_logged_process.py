"""LoggedProcessOperation with real processes: a run must end when its process exits.

An exited child keeps its /proc entry (a zombie) until it is reaped, so a
liveness check based on /proc alone never sees it finish and the job hangs.
These tests run real processes under a SIGALRM guard so a regression fails
instead of hanging the suite.
"""

import signal
import subprocess
import time

import pytest

from drives.drive_models import DriveContext, DriveDescriptor, DriveTraits
from operations import logged_process
from operations.catalog.dd_read_test import DDReadTestOperation
from operations.catalog.dd_write_test import DDWriteTestOperation
from operations.logged_process import LoggedProcessOperation

TIMEOUT_SECONDS = 10


@pytest.fixture(autouse=True)
def fail_instead_of_hang():
    def _timeout(_signum, _frame):
        raise TimeoutError(f"operation did not finish within {TIMEOUT_SECONDS}s (process never seen exiting?)")

    previous = signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(TIMEOUT_SECONDS)
    yield
    signal.alarm(0)
    signal.signal(signal.SIGALRM, previous)


class _ShellOperation(LoggedProcessOperation):
    """Runs a shell snippet; the "device" is passed as $0 so PID matching works."""

    name = "Shell (test)"
    category = "Debug"
    tool = "sh"
    program = "sh"

    def _build_command(self, context, params):
        return ["sh", "-c", params["script"], context.descriptor.device_name]

    def _finished_in_log(self):
        return b"done" in self._log_path.read_bytes()

    def _verdict(self, returncode):
        self._message = "Done"
        return {"returncode": returncode, "log": self._log_path.read_text().strip()}


DEVICE = "fake-device-for-test"
_SHELL_CONTEXT = DriveContext(guid="g", descriptor=DriveDescriptor(DEVICE, "sat", DEVICE))


# ---------------------------------------------------------------------------
# Started by run()
# ---------------------------------------------------------------------------

def test_dd_write_then_read_complete_on_a_real_file(tmp_path, monkeypatch):
    monkeypatch.setattr(logged_process, "is_device_mounted", lambda _d: False)
    img = tmp_path / "drive.img"
    size = 8 * 1024 * 1024
    img.write_bytes(b"\xff" * size)
    context = DriveContext(
        guid="g", descriptor=DriveDescriptor(str(img), "sat", str(img)), traits=DriveTraits(capacity_bytes=size)
    )

    write = DDWriteTestOperation()
    result = write.run(context, {"block_size": 1048576, "count": 0, "skip": 0, "conv_fsync": True, "oflag_direct": False})
    assert result == {"bytes_written": size, "device": str(img), "block_size": 1048576}
    assert img.read_bytes() == b"\x00" * size

    read = DDReadTestOperation()
    params = {"block_size": 1048576, "count": 0, "skip": 0, "conv_noerror": False, "conv_sync": False, "iflag_direct": False}
    assert read.run(context, params)["bytes_read"] == size


def test_run_reports_the_real_exit_code(tmp_path):
    op = _ShellOperation()
    result = op.run(_SHELL_CONTEXT, {"script": "echo working >&2; sleep 0.3; echo done >&2; exit 3"})
    assert result["returncode"] == 3


# ---------------------------------------------------------------------------
# Reattached after a restart
# ---------------------------------------------------------------------------

def _reattach_data(pid, log_path):
    return {"pid": pid, "log_path": str(log_path), "device": DEVICE}


def test_reattach_sees_an_exited_zombie_as_finished(tmp_path):
    # A process that exited but hasn't been reaped keeps its /proc entry.
    # It must count as finished, not running.
    log = tmp_path / "job.log"
    with open(log, "wb") as f:
        proc = subprocess.Popen(["sh", "-c", "echo working >&2; sleep 0.5; echo done >&2", DEVICE], stderr=f)
    time.sleep(0.1)  # let it start; it is deliberately never wait()ed on
    result = _ShellOperation().reattach(_SHELL_CONTEXT, {}, _reattach_data(proc.pid, log))
    assert result["returncode"] is None
    assert "done" in result["log"]
    proc.wait()


def test_reattach_to_a_process_started_by_a_previous_backend_finishes(tmp_path):
    # A restart spawns a new backend process; the job's process was started by
    # the old one and has been reparented, so it is not our child.
    log = tmp_path / "job.log"
    launcher = subprocess.run(
        ["sh", "-c", f"sh -c 'echo working >&2; sleep 0.5; echo done >&2' {DEVICE} 2>>{log} & echo $!"],
        capture_output=True, text=True, check=True,
    )
    pid = int(launcher.stdout.strip())
    result = _ShellOperation().reattach(_SHELL_CONTEXT, {}, _reattach_data(pid, log))
    assert result["returncode"] is None  # exit code isn't recoverable for a non-child
    assert "done" in result["log"]


# ---------------------------------------------------------------------------
# Targeting the kernel block device, not smartctl's path
# ---------------------------------------------------------------------------

from operations.catalog.badblocks_write_test import BadblocksWriteTestOperation  # noqa: E402
from operations.catalog.secure_erase import SecureEraseOperation  # noqa: E402

_PROCESS_OPS = [DDReadTestOperation, DDWriteTestOperation, BadblocksWriteTestOperation, SecureEraseOperation]


def _nvme_context(block_device="nvme0n1"):
    # smartctl talks to the NVMe controller; the data lives on the namespace.
    return DriveContext(
        guid="g", descriptor=DriveDescriptor("/dev/nvme0", "nvme", "/dev/nvme0"),
        traits=DriveTraits(serial="NVME-SER", capacity_bytes=1 << 30), block_device=block_device,
    )


@pytest.mark.parametrize("op_cls", _PROCESS_OPS)
def test_process_operations_target_the_block_device(op_cls, real_block_device_path):
    op = op_cls()
    context = _nvme_context()
    params = {p.name: p.default for p in op.params}
    op._configure(context, params)
    cmd = op._build_command(context, params)
    assert any(arg.endswith("/dev/nvme0n1") for arg in cmd)
    assert not any(arg.endswith("/dev/nvme0") for arg in cmd)


@pytest.mark.parametrize("op_cls", _PROCESS_OPS)
def test_process_operations_need_a_resolved_block_device(op_cls):
    assert op_cls.supports(_nvme_context()) is True
    assert op_cls.supports(_nvme_context(block_device=None)) is False
    megaraid = DriveContext(guid="g", descriptor=DriveDescriptor("/dev/bus/0", "megaraid,3", "/dev/bus/0"),
                            block_device="sdd")
    assert op_cls.supports(megaraid) is True


def test_run_refuses_when_the_serial_now_resolves_elsewhere(monkeypatch, real_block_device_path, tmp_path):
    monkeypatch.setattr(logged_process, "resolve_block_device", lambda serial: "sdc")
    context = DriveContext(guid="g", descriptor=DriveDescriptor("/dev/sdb", "sat", "/dev/sdb"),
                           traits=DriveTraits(serial="SER-A"), block_device="sdb")
    op = _ShellOperation()
    with pytest.raises(RuntimeError, match="now /dev/sdc, not /dev/sdb"):
        op.run(context, {"script": "echo should-not-run >&2"})
    assert not (tmp_path / "job_logs").exists()  # nothing was started


def test_run_refuses_when_the_block_device_is_gone(monkeypatch, real_block_device_path, tmp_path):
    monkeypatch.setattr(logged_process, "resolve_block_device", lambda serial: None)
    context = DriveContext(guid="g", descriptor=DriveDescriptor("/dev/sdb", "sat", "/dev/sdb"),
                           traits=DriveTraits(serial="SER-A"), block_device="sdb")
    with pytest.raises(RuntimeError, match="not found"):
        _ShellOperation().run(context, {"script": "echo should-not-run >&2"})
    assert not (tmp_path / "job_logs").exists()
