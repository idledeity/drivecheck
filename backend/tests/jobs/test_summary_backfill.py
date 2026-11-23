"""Summary logs for jobs that finished before their operation kept one."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from database import db
from jobs import summary_backfill
from jobs.job_models import Job, JobStatus
from jobs.summary_backfill import backfill_summary_logs
from operations import job_logs
from operations.catalog.badblocks_write_test import BadblocksWriteTestOperation
from operations.catalog.dd_read_test import DDReadTestOperation
from operations.catalog.smart_self_test_short import SmartSelfTestShortOperation

FIXTURES = Path(__file__).parent.parent / "operations" / "fixtures"
DD_SIZE = 800 * 1024 * 1024  # the dd fixture's run
DD_PARAMS = {"block_size": 1048576, "count": 0, "skip": 0, "conv_noerror": False, "conv_sync": False, "iflag_direct": False}


def _id(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


@pytest.fixture(autouse=True)
def _setup(isolated_data_dir, monkeypatch):
    db.init()
    job_logs.log_dir().mkdir()
    monkeypatch.setattr(summary_backfill, "OPERATIONS", {
        "badblocks": BadblocksWriteTestOperation,
        "dd_read": DDReadTestOperation,
        "smart_short": SmartSelfTestShortOperation,
    })


def _past_job(n, operation, params, fixture=None, status=JobStatus.COMPLETED, summary=None, guid="g1"):
    job_id = _id(n)
    db.record_job(Job(id=job_id, drive_guid=guid, operation=operation, category="Scan", params=params,
                      status=status, created_at=datetime(2026, 1, 1, 0, n, tzinfo=UTC), summary_log=summary))
    if fixture:
        job_logs.raw_log_path(job_id).write_bytes((FIXTURES / fixture).read_bytes())
    return job_id


def test_adds_summaries_from_the_raw_logs_of_past_jobs():
    bb = _past_job(1, "badblocks", {"block_size": 4096, "passes": 1}, "badblocks_w_s_v_one_clean_pass.log")
    failed = _past_job(2, "badblocks", {"block_size": 4096, "passes": 1}, "badblocks_w_s_v_one_clean_pass.log",
                       status=JobStatus.FAILED)
    outcomes = backfill_summary_logs()
    assert [(o.job_id, o.status) for o in outcomes] == [(bb, "added"), (failed, "added")]
    assert db.get_job_summary_log(bb).endswith("Pass completed, 0 bad blocks found. (0/0/0 errors)\n")


def test_dd_uses_the_drive_capacity_on_record_for_its_samples():
    db.upsert_drive_record("g1", "SER", "Model", DD_SIZE, "HDD", datetime(2026, 1, 1, tzinfo=UTC).isoformat())
    job_id = _past_job(1, "dd_read", DD_PARAMS, "dd_progress_800mib_complete.log")
    backfill_summary_logs()
    summary = db.get_job_summary_log(job_id).splitlines()
    assert summary[0] == "114294784 bytes (114 MB, 109 MiB) copied, 2 s, 57.0 MB/s"  # the 10% sample
    assert summary[-1] == "838860800 bytes (839 MB, 800 MiB) copied, 15.3907 s, 54.5 MB/s"


def test_dd_without_a_recorded_capacity_keeps_just_the_outcome():
    job_id = _past_job(1, "dd_read", DD_PARAMS, "dd_progress_800mib_complete.log", guid="never-recorded")
    backfill_summary_logs()
    assert db.get_job_summary_log(job_id).splitlines()[0] == "800+0 records in"


def test_leaves_existing_summaries_running_jobs_and_logless_operations_alone():
    kept = _past_job(1, "badblocks", {"block_size": 4096, "passes": 1}, "badblocks_w_s_v_one_clean_pass.log",
                     summary="already here\n")
    running = _past_job(2, "badblocks", {"block_size": 4096, "passes": 1}, "badblocks_w_s_v_one_clean_pass.log",
                        status=JobStatus.RUNNING)
    smart = _past_job(3, "smart_short", {})
    removed = _past_job(4, "operation_since_removed", {})
    assert backfill_summary_logs() == []
    assert db.get_job_summary_log(kept) == "already here\n"
    assert db.get_job_summary_log(running) is None
    assert db.get_job_summary_log(smart) is None
    assert db.get_job_summary_log(removed) is None


def test_reports_a_job_whose_raw_log_is_gone():
    job_id = _past_job(1, "badblocks", {"block_size": 4096, "passes": 1})
    assert [(o.job_id, o.status) for o in backfill_summary_logs()] == [(job_id, "no raw log")]


def test_a_second_run_adds_nothing():
    _past_job(1, "badblocks", {"block_size": 4096, "passes": 1}, "badblocks_w_s_v_one_clean_pass.log")
    assert len(backfill_summary_logs()) == 1
    assert backfill_summary_logs() == []


def test_one_unreadable_job_does_not_stop_the_rest():
    bad = _past_job(1, "badblocks", {}, "badblocks_w_s_v_one_clean_pass.log")  # params missing
    good = _past_job(2, "badblocks", {"block_size": 4096, "passes": 1}, "badblocks_w_s_v_one_clean_pass.log")
    outcomes = {o.job_id: o.status for o in backfill_summary_logs()}
    assert outcomes == {bad: "failed", good: "added"}
