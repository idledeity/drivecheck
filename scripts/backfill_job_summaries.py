"""
scripts/backfill_job_summaries.py — Add summary logs to past jobs.

Usage (from the repo root):
    backend/.venv/bin/python scripts/backfill_job_summaries.py

Jobs that ended before their operation kept a summary get one from their raw
log, if it still exists (see jobs.summary_backfill). Jobs that already have a
summary are left alone, so it is safe to run again, and safe while the
backend is running: the History tab shows the new summaries on its next load.
"""

import logging
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "backend"))

from settings import cfg  # noqa: E402
from system_utils import paths  # noqa: E402,F401  (registers data.dir)
from database import db  # noqa: E402
from jobs.summary_backfill import backfill_summary_logs  # noqa: E402
from operations.operation_registry import discover  # noqa: E402


def main() -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    cfg.load(_REPO / "config.yaml")
    db.init()
    discover()
    outcomes = backfill_summary_logs()
    for o in outcomes:
        print(f"{o.job_id}  {o.operation:<24} {o.status}{'  ' + o.detail if o.detail else ''}")
    added = sum(o.status == "added" for o in outcomes)
    print(f"{added} summar{'y' if added == 1 else 'ies'} added")
    return 1 if any(o.status == "failed" for o in outcomes) else 0


if __name__ == "__main__":
    sys.exit(main())
