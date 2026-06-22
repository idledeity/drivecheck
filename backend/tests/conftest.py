import pytest

from system_utils import paths


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """Point paths.data_dir() at a per-test tmp_path so no test ever touches the real data dir."""
    monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
    return tmp_path
