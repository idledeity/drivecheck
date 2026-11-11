import pytest

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
    return tmp_path
