"""A job's output: finding its raw log by id (the id comes from a URL, so it
must never reach outside the log directory), and limiting the stored summary."""

import logging

import pytest

from operations import job_logs
from operations.job_logs import SUMMARY_MAX_BYTES, SUMMARY_WARN_BYTES, limit_summary

JOB_ID = "0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d"


def test_raw_log_info_reports_its_size(tmp_path):
    job_logs.log_dir().mkdir()
    job_logs.raw_log_path(JOB_ID).write_bytes(b"x" * 10)
    assert job_logs.raw_log_info(JOB_ID) == {"size": 10}
    assert job_logs.existing_raw_log(JOB_ID) == job_logs.raw_log_path(JOB_ID)


def test_a_job_without_a_raw_log(tmp_path):
    assert job_logs.raw_log_info(JOB_ID) is None
    assert job_logs.existing_raw_log(JOB_ID) is None


@pytest.mark.parametrize("job_id", ["../../etc/passwd", "..", "unknown", JOB_ID.upper(), JOB_ID + "/x"])
def test_ids_that_are_not_job_ids_find_nothing(tmp_path, job_id):
    (tmp_path / "job_logs").mkdir()
    (tmp_path / "job_logs" / f"{job_id.replace('/', '_')}.log").write_text("x")
    assert job_logs.existing_raw_log(job_id) is None


# ---------------------------------------------------------------------------
# limit_summary
# ---------------------------------------------------------------------------

def _lines(count: int, width: int = 63) -> str:
    return "".join(f"{i:06d} " + "x" * (width - 7) + "\n" for i in range(count))  # width+1 bytes each


def test_a_normal_summary_is_stored_as_is_without_a_warning(caplog):
    text = _lines(10)
    with caplog.at_level(logging.WARNING):
        assert limit_summary(text, JOB_ID) is text
    assert not caplog.records


def test_a_large_summary_is_kept_whole_but_warned_about(caplog):
    text = _lines(SUMMARY_WARN_BYTES // 64 + 1)
    assert SUMMARY_WARN_BYTES < len(text) <= SUMMARY_MAX_BYTES
    with caplog.at_level(logging.WARNING):
        assert limit_summary(text, JOB_ID) == text
    assert "0b6f3c1e" in caplog.text and "summarizer may be keeping too much" in caplog.text
    assert "cut to" not in caplog.text


def test_an_oversized_summary_keeps_its_start_and_end(caplog):
    lines = _lines(1000).splitlines(keepends=True)  # 64 KB
    with caplog.at_level(logging.WARNING):
        limited = limit_summary("".join(lines), JOB_ID)
    assert f"cut to {SUMMARY_MAX_BYTES}" in caplog.text
    assert len(limited.encode()) <= SUMMARY_MAX_BYTES
    kept = limited.splitlines(keepends=True)
    marker = next(i for i, line in enumerate(kept) if "omitted" in line)
    assert kept[:marker] == lines[:marker]                     # the start, unchanged
    assert kept[marker + 1:] == lines[-(len(kept) - marker - 1):]  # the end, unchanged
    omitted = len(lines) - (len(kept) - 1)
    assert kept[marker] == f"\u2026 {omitted:,} lines ({omitted * 64 / 1024:,.1f} KB) omitted \u2014 see the raw log \u2026\n"
