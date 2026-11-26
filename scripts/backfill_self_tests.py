"""
scripts/backfill_self_tests.py — Fill drive_self_tests from the raw
snapshots still kept.

Usage (from the repo root):
    backend/.venv/bin/python scripts/backfill_self_tests.py

Every full read saved before drive_self_tests existed holds the drive's
self-test log; this replays them, oldest first, so tests the drives' logs
have since rolled out are kept too. Entries already recorded only get their
first/last seen times widened, so it is safe to run again, and safe while the
backend is running.
"""

import json
import logging
import sys
from collections import Counter
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "backend"))

from settings import cfg, config_file  # noqa: E402
from system_utils import paths  # noqa: E402,F401  (registers data.dir)
from database import db  # noqa: E402
from drives.collector.probes.telemetry.smartctl_self_test_log import observed_self_tests  # noqa: E402


def main() -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    cfg.load(config_file.path())
    db.init()
    reads, added = Counter(), Counter()
    for guid, captured_at, smartctl_json in db.iter_raw_snapshot_reports():
        if not smartctl_json:
            continue
        reads[guid] += 1
        added[guid] += db.record_self_tests(guid, captured_at, observed_self_tests(json.loads(smartctl_json)))
    for guid in reads:
        print(f"{guid}  {reads[guid]:>5} read(s)  {added[guid]:>3} new entr{'y' if added[guid] == 1 else 'ies'}")
    print(f"{sum(added.values())} self-test entr{'y' if sum(added.values()) == 1 else 'ies'} added")
    return 0


if __name__ == "__main__":
    sys.exit(main())
