"""
analysis.stored_facts — The attribute facts of a stored full read, for scoring
a past point (a history point, a job's before/after summary) with the same
inputs the live score had.

A raw snapshot never changes once written, so its facts are cached by id. The
key includes captured_at too: SQLite can hand a pruned row's id to a new row,
and a new row never shares its time.
"""

import json
import logging
import threading

from database import db

logger = logging.getLogger(__name__)

_CACHE_SIZE = 4096
_cache: dict[tuple[int, str], dict] = {}
_lock = threading.Lock()


def snapshot_extras(snapshot_id: int | None, captured_at: str | None) -> dict | None:
    """{smart_attributes, self_test_log} of the raw snapshot, or None if
    there's no id or the snapshot is gone (pruned) or isn't the one meant."""
    if snapshot_id is None:
        return None
    return many_snapshot_extras([(snapshot_id, captured_at)]).get(snapshot_id)


def many_snapshot_extras(snapshots: list[tuple[int, str | None]]) -> dict[int, dict]:
    """snapshot_extras for many (id, captured_at) at once, by id, loading the
    ones not cached in one query. Missing ones are left out."""
    with _lock:
        found = {sid: _cache[(sid, at)] for sid, at in snapshots if (sid, at) in _cache}
    wanted = {sid: at for sid, at in snapshots if sid not in found}
    if not wanted:
        return found
    loaded = {}
    for sid, at, attributes, self_test_log in db.get_raw_snapshot_facts(list(wanted)):
        if wanted[sid] is not None and wanted[sid] != at:
            continue    # the id now names a different read
        loaded[(sid, at)] = {
            "smart_attributes": json.loads(attributes) if attributes else [],
            "self_test_log": json.loads(self_test_log) if self_test_log else [],
        }
    logger.debug("loaded the facts of %d of %d raw snapshot(s)", len(loaded), len(wanted))
    with _lock:
        if len(_cache) + len(loaded) > _CACHE_SIZE:
            _cache.clear()
        _cache.update(loaded)
    return {**found, **{sid: extras for (sid, _), extras in loaded.items()}}


def clear_cache() -> None:
    with _lock:
        _cache.clear()
