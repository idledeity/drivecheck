import json

import pytest

from analysis.stored_facts import snapshot_extras
from database import db


@pytest.fixture(autouse=True)
def _init_db(isolated_data_dir):
    db.init()


def _record(at, **report):
    return db.record_raw_snapshot("g1", at, "smartctl_telemetry", json.dumps({"smartctl": {"big": 1}, **report}))


def test_a_snapshots_attribute_facts_and_self_test_log():
    rows = [{"key": "ata_5", "value": "0"}]
    sid = _record("2026-01-01T00:00:00", smart_attributes=rows, self_test_log=[{"key": "t0"}])
    assert snapshot_extras(sid, "2026-01-01T00:00:00") == {"smart_attributes": rows, "self_test_log": [{"key": "t0"}]}


def test_a_snapshot_stored_without_them_has_empty_lists():
    sid = _record("2026-01-01T00:00:00")
    assert snapshot_extras(sid, "2026-01-01T00:00:00") == {"smart_attributes": [], "self_test_log": []}


def test_a_missing_or_different_snapshot_is_none():
    sid = _record("2026-01-01T00:00:00")
    assert snapshot_extras(None, None) is None
    assert snapshot_extras(sid + 1, "2026-01-01T00:00:00") is None
    assert snapshot_extras(sid, "2026-01-02T00:00:00") is None    # the id now names a newer read
