import os
import time

import pytest

from analysis import stored_facts
from system_utils import paths


@pytest.fixture(scope="session", autouse=True)
def stray_data_dir(tmp_path_factory):
    """Backstop: outside a test's own isolated_data_dir, data_dir() points at a
    session scratch folder, never the real data/ folder.

    That covers a background thread (e.g. a job thread) that is still running
    when its test ends and isolated_data_dir has been undone. Anything written
    here means some test let work outlive it, so the session fails and names it.
    """
    stray = tmp_path_factory.mktemp("stray-data-dir")
    original = paths.data_dir
    paths.data_dir = lambda: stray
    yield stray
    paths.data_dir = original
    leaked = sorted(str(p.relative_to(stray)) for p in stray.rglob("*"))
    assert not leaked, (
        f"files were written to the data dir outside any test (a background thread outlived its test?): {leaked}"
    )


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """Point paths.data_dir() at a per-test tmp_path so no test ever touches the real data dir."""
    monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
    stored_facts.clear_cache()    # each test's database reuses the same ids
    return tmp_path


@pytest.fixture
def local_zone():
    """Set the process's local time zone for one test (e.g. "America/Chicago"),
    for code that reads naive local times — the UTC migration, clock.parse on
    legacy values. Restored afterwards."""
    saved = os.environ.get("TZ")

    def set_zone(name: str) -> None:
        os.environ["TZ"] = name
        time.tzset()

    yield set_zone
    if saved is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = saved
    time.tzset()


@pytest.fixture
def utc_zone(local_zone):
    """Local time is UTC for this test, so naive times convert to themselves."""
    local_zone("UTC")
