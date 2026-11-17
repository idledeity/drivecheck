"""
operations.job_logs — A job's output: where its raw log lives, and the limits
on the summary of it that is stored with the job.

  <job_id>.log   the program's raw stderr, exactly as written (a file: it can
                 be tens of MB, and may later be pruned)
  summary_log    the important lines of it, from operations that summarize;
                 a column of the job's row, so it outlives the raw log

The raw log is named from the job id alone, so the API can find it for any
job, including past ones, without asking the operation.
"""

import logging
import re
from pathlib import Path

from system_utils import paths

logger = logging.getLogger(__name__)

# Job ids are uuid4 strings. Checked before building a path from one, so an id
# taken from a URL can never point outside the log directory.
_JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# A real summary is about 1 KB (a 1-pass badblocks run: 765 bytes). Past
# SUMMARY_WARN_BYTES a summarizer is probably keeping too much, so say so;
# past SUMMARY_MAX_BYTES the middle is cut so one bad summarizer can't bloat the DB.
SUMMARY_WARN_BYTES = 4 * 1024
SUMMARY_MAX_BYTES = 16 * 1024
_MARKER_ALLOWANCE = 128  # room for the omission line within SUMMARY_MAX_BYTES


def log_dir() -> Path:
    return paths.data_dir() / "job_logs"


def raw_log_path(job_id: str) -> Path:
    return log_dir() / f"{job_id}.log"


def existing_raw_log(job_id: str) -> Path | None:
    """The job's raw log if it exists, else None (also for a malformed id)."""
    if not _JOB_ID_RE.match(job_id):
        return None
    path = raw_log_path(job_id)
    return path if path.is_file() else None


def raw_log_info(job_id: str) -> dict | None:
    """{"size": bytes} for the job's raw log, or None if it has none."""
    path = existing_raw_log(job_id)
    try:
        return {"size": path.stat().st_size} if path else None
    except OSError:
        return None


def limit_summary(text: str, job_id: str) -> str:
    """The summary to store: as is up to SUMMARY_MAX_BYTES (with a warning past
    SUMMARY_WARN_BYTES), else its first and last lines around a note of what
    was cut. The end is kept because it holds the outcome (e.g. pass results)."""
    size = len(text.encode("utf-8"))
    if size <= SUMMARY_WARN_BYTES:
        return text
    logger.warning(
        "job %s: summary log is %d bytes (expected under %d) — its summarizer may be keeping too much%s",
        job_id[:8], size, SUMMARY_WARN_BYTES,
        f"; cut to {SUMMARY_MAX_BYTES}" if size > SUMMARY_MAX_BYTES else "",
    )
    if size <= SUMMARY_MAX_BYTES:
        return text

    lines = text.splitlines(keepends=True)
    budget = (SUMMARY_MAX_BYTES - _MARKER_ALLOWANCE) // 2

    def fit(candidates) -> list[str]:
        kept, used = [], 0
        for line in candidates:
            used += len(line.encode("utf-8"))
            if used > budget:
                break
            kept.append(line)
        return kept

    head = fit(lines)
    tail = fit(reversed(lines[len(head):]))[::-1]
    omitted = lines[len(head):len(lines) - len(tail)]
    omitted_kb = sum(len(line.encode("utf-8")) for line in omitted) / 1024
    marker = f"… {len(omitted):,} lines ({omitted_kb:,.1f} KB) omitted — see the raw log …\n"
    return "".join(head) + marker + "".join(tail)
