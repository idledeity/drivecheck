import pytest

from settings import cfg
from system_utils import paths


@pytest.fixture(autouse=True)
def isolated_data_dir():
    """Shadow conftest's autouse paths.data_dir monkeypatch — this file tests
    the real implementation, so it must not be stubbed out."""
    return None


@pytest.fixture(autouse=True)
def isolated_cfg_values(monkeypatch):
    monkeypatch.setattr(cfg, "_values", dict(cfg._values))


def test_data_dir_uses_default_when_unset():
    assert paths.data_dir().name == "data"


def test_data_dir_resolves_relative_path_against_project_root():
    cfg.set("data.dir", "./some/relative/dir")
    result = paths.data_dir()
    assert result.is_absolute()
    assert result.parts[-3:] == ("some", "relative", "dir")


def test_data_dir_resolves_absolute_path_unchanged(tmp_path):
    cfg.set("data.dir", str(tmp_path))
    assert paths.data_dir() == tmp_path.resolve()
