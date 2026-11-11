"""SMART self-test result attribution.

Right after a self-test is started, the drive may still report the previous
test's result. These tests feed scripted `smartctl -a` responses and check that
a finished-looking status only passes when there is proof it belongs to the
test this job started.
"""

import json
from pathlib import Path

import pytest

from drives.drive_models import DriveContext, DriveDescriptor, DriveTraits, DriveType
from drives.tools.smartctl import SmartctlResult
from operations.catalog import smart_self_test_base
from operations.catalog.smart_self_test_base import _log_has_new_entry
from operations.catalog.smart_self_test_conveyance import SmartSelfTestConveyanceOperation
from operations.catalog.smart_self_test_long import SmartSelfTestLongOperation
from operations.catalog.smart_self_test_short import SmartSelfTestShortOperation

DEVICE = "/dev/sdz"


# ---------------------------------------------------------------------------
# smartctl JSON builders (shapes taken from real drives)
# ---------------------------------------------------------------------------

def _scsi_entry(result="Completed", hours=48154, code="Background long"):
    return {
        "code": {"value": 2, "string": code},
        "result": {"value": 0, "string": result},
        "power_on_time": {"hours": hours, "aka": "accumulated_power_on_hours"},
    }


def _scsi(entries, in_progress=False, poh=51326):
    data = {"power_on_time": {"hours": poh}}
    for i, entry in enumerate(entries):
        data[f"scsi_self_test_{i}"] = dict(entry)
    if in_progress:
        data["scsi_self_test_0"]["self_test_in_progress"] = True
    return data


def _ata_entry(status="Completed without error", hours=20512):
    return {"type": {"string": "Extended offline"}, "status": {"string": status, "passed": True}, "lifetime_hours": hours}


def _ata(table, remaining=None, status="completed without error", poh=20512):
    st = {"value": 0, "string": status, "passed": True}
    if remaining is not None:
        st = {"value": 240 + remaining // 10, "string": f"in progress, {remaining}% remaining", "remaining_percent": remaining}
    return {
        "power_on_time": {"hours": poh},
        "ata_smart_data": {"self_test": {"status": st}},
        "ata_smart_self_test_log": {"standard": {"revision": 1, "count": len(table), "table": table}},
    }


def _context(drive_type):
    return DriveContext(
        guid="g",
        descriptor=DriveDescriptor(device_name=DEVICE, access_type="sat", info_name=DEVICE),
        traits=DriveTraits(drive_type=drive_type),
    )


@pytest.fixture
def smartctl_script(monkeypatch):
    """Script the successive `smartctl -a` responses; the last one repeats."""
    responses: list[dict] = []
    calls = {"n": 0}

    def attributes_all(_device, _access_type):
        i = min(calls["n"], len(responses) - 1)
        calls["n"] += 1
        return responses[i]

    monkeypatch.setattr(smart_self_test_base, "_POLL_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(smart_self_test_base.smartctl, "attributes_all", attributes_all)
    monkeypatch.setattr(
        smart_self_test_base.smartctl, "self_test_start", lambda *_a: SmartctlResult(success=True, message="")
    )
    monkeypatch.setattr(smart_self_test_base.smartctl, "self_test_abort", lambda *_a: SmartctlResult(True, ""))
    return responses


def _run(drive_type):
    op = SmartSelfTestLongOperation()
    op._save_reattach_cb = lambda: None
    return op, op.run(_context(drive_type), {})


# ---------------------------------------------------------------------------
# Which drives offer which test
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("drive_type,short_long,conveyance", [
    (DriveType.HDD, True, True),
    (DriveType.SSD, True, True),
    (DriveType.SAS, True, False),
    (DriveType.NVME, True, False),
])
def test_supported_tests_follow_the_drive_interface(drive_type, short_long, conveyance):
    context = _context(drive_type)
    assert SmartSelfTestShortOperation.supports(context) is short_long
    assert SmartSelfTestLongOperation.supports(context) is short_long
    assert SmartSelfTestConveyanceOperation.supports(context) is conveyance


def test_drives_without_self_test_support_get_none():
    unsupported = [t for t in DriveType if t not in (DriveType.HDD, DriveType.SSD, DriveType.SAS, DriveType.NVME)]
    for drive_type in unsupported:
        assert not SmartSelfTestShortOperation.supports(_context(drive_type))


# ---------------------------------------------------------------------------
# _log_has_new_entry
# ---------------------------------------------------------------------------

def test_new_entry_when_log_grows_even_if_rows_are_identical():
    old = [_scsi_entry()] * 3
    assert _log_has_new_entry(old, [_scsi_entry()] * 4) is True


def test_no_new_entry_when_log_is_unchanged():
    old = [_scsi_entry()] * 3
    assert _log_has_new_entry(old, list(old)) is False


def test_new_entry_when_full_log_rotates():
    old = [_scsi_entry(hours=h) for h in (3, 2, 1)]
    assert _log_has_new_entry(old, [_scsi_entry(hours=h) for h in (4, 3, 2)]) is True


# ---------------------------------------------------------------------------
# SAS — the drives with identical July log rows
# ---------------------------------------------------------------------------

STALE_SCSI = [_scsi_entry(result="Completed")] * 3


def test_sas_stale_completed_result_never_passes(smartctl_script):
    # The drive never registers the new test: the log keeps showing the old,
    # identical "Completed" rows. Old code passed this on the first poll.
    smartctl_script.append(_scsi(STALE_SCSI))
    with pytest.raises(RuntimeError, match="could not confirm"):
        _run(DriveType.SAS)


def test_sas_test_seen_running_then_completed_passes(smartctl_script):
    running = _scsi([_scsi_entry(result="Self test in progress ...", hours=51326)] + STALE_SCSI, in_progress=True)
    done = _scsi([_scsi_entry(result="Completed", hours=51340)] + STALE_SCSI)
    smartctl_script.extend([_scsi(STALE_SCSI), running, running, done])
    op, result = _run(DriveType.SAS)
    assert result["result"] == "Completed"
    assert op.get_progress().message == "Done"


def test_sas_fast_test_never_seen_running_passes_on_new_log_entry(smartctl_script):
    done = _scsi([_scsi_entry(result="Completed", hours=51326)] + STALE_SCSI)
    smartctl_script.extend([_scsi(STALE_SCSI), done])
    _op, result = _run(DriveType.SAS)
    assert result["result"] == "Completed"


def test_sas_new_failed_entry_fails(smartctl_script):
    done = _scsi([_scsi_entry(result="Failed in read element", hours=51326)] + STALE_SCSI)
    smartctl_script.extend([_scsi(STALE_SCSI), done])
    with pytest.raises(RuntimeError, match="Failed in read element"):
        _run(DriveType.SAS)


# ---------------------------------------------------------------------------
# ATA — e.g. a drive whose status already reads "completed without error"
# ---------------------------------------------------------------------------

def test_ata_stale_status_with_empty_log_never_passes(smartctl_script):
    smartctl_script.append(_ata([]))
    with pytest.raises(RuntimeError, match="could not confirm"):
        _run(DriveType.HDD)


def test_ata_test_seen_running_then_completed_passes(smartctl_script):
    smartctl_script.extend([
        _ata([]),
        _ata([], remaining=90),
        _ata([], remaining=40),
        _ata([_ata_entry()], status="completed without error"),
    ])
    op, result = _run(DriveType.HDD)
    assert "without error" in result["result"]
    assert op.get_progress().message == "Done"


def test_ata_late_registration_is_waited_for(smartctl_script):
    # First polls still show the old status; then the drive reports the test.
    smartctl_script.extend([
        _ata([]),
        _ata([]),
        _ata([]),
        _ata([], remaining=50),
        _ata([_ata_entry(status="Completed: read failure")], status="completed: read failure"),
    ])
    with pytest.raises(RuntimeError, match="read failure"):
        _run(DriveType.HDD)


# ---------------------------------------------------------------------------
# Real SAS responses — captured around a short self-test on a real drive
# ---------------------------------------------------------------------------

REAL_SAS = json.loads((Path(__file__).parent / "fixtures" / "smart_sas_short_selftest.json").read_text())
REAL_START_HOURS = REAL_SAS["before_start"]["power_on_time"]["hours"]


def _run_short():
    op = SmartSelfTestShortOperation()
    op._save_reattach_cb = lambda: None
    return op, op.run(_context(DriveType.SAS), {})


def test_real_sas_short_test_passes(smartctl_script):
    smartctl_script.extend([REAL_SAS["before_start"], REAL_SAS["running"], REAL_SAS["running"], REAL_SAS["completed"]])
    op, result = _run_short()
    assert result == {"device": DEVICE, "test_type": "short", "result": "Completed"}
    assert op.get_reattach_data() == {"start_hours": REAL_START_HOURS}


def test_real_sas_drive_that_never_starts_the_test_fails(smartctl_script):
    # Its newest entry is an old "Aborted"; nothing new ever appears.
    smartctl_script.append(REAL_SAS["before_start"])
    with pytest.raises(RuntimeError, match="could not confirm"):
        _run_short()


def test_real_sas_reattach_while_running_then_completes(smartctl_script):
    smartctl_script.extend([REAL_SAS["running"], REAL_SAS["running"], REAL_SAS["completed"]])
    op = SmartSelfTestShortOperation()
    result = op.reattach(_context(DriveType.SAS), {}, {"start_hours": REAL_START_HOURS})
    assert result["result"] == "Completed"


def test_real_sas_finished_during_downtime_is_recovered(smartctl_script):
    # The finished entry is stamped with the power-on-hours of the test's start.
    smartctl_script.append(REAL_SAS["completed"])
    op = SmartSelfTestShortOperation()
    result = op.reattach(_context(DriveType.SAS), {}, {"start_hours": REAL_START_HOURS})
    assert result["result"] == "Completed"


# ---------------------------------------------------------------------------
# Real ATA responses — captured around a short self-test on a real SATA drive
# ---------------------------------------------------------------------------

REAL_ATA = json.loads((Path(__file__).parent / "fixtures" / "smart_ata_short_selftest.json").read_text())
REAL_ATA_START_HOURS = REAL_ATA["before_start"]["power_on_time"]["hours"]


def _run_short_ata():
    op = SmartSelfTestShortOperation()
    op._save_reattach_cb = lambda: None
    return op, op.run(_context(DriveType.HDD), {})


def test_real_ata_short_test_passes_with_percent_progress(smartctl_script):
    smartctl_script.extend([REAL_ATA["before_start"], REAL_ATA["running"], REAL_ATA["running_later"], REAL_ATA["completed"]])
    op, result = _run_short_ata()
    assert "without error" in result["result"]
    assert op.get_reattach_data() == {"start_hours": REAL_ATA_START_HOURS}


def test_real_ata_stale_completed_status_is_not_taken_as_the_result(smartctl_script):
    # Before the start this drive already reads "completed without error",
    # with an empty self-test log. If the test never registers, that must not pass.
    smartctl_script.append(REAL_ATA["before_start"])
    with pytest.raises(RuntimeError, match="could not confirm"):
        _run_short_ata()


def test_real_ata_reattach_while_running_then_completes(smartctl_script):
    # The in-progress log entry carries real lifetime_hours (not 0/"NOW") on this drive.
    smartctl_script.extend([REAL_ATA["running_later"], REAL_ATA["completed"]])
    op = SmartSelfTestShortOperation()
    result = op.reattach(_context(DriveType.HDD), {}, {"start_hours": REAL_ATA_START_HOURS})
    assert "without error" in result["result"]


def test_real_ata_finished_during_downtime_is_recovered(smartctl_script):
    smartctl_script.append(REAL_ATA["completed"])
    op = SmartSelfTestShortOperation()
    result = op.reattach(_context(DriveType.HDD), {}, {"start_hours": REAL_ATA_START_HOURS})
    assert result["result"] == "Completed without error"
