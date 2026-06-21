import json

import pytest

from settings import user_settings
from system_utils import paths


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)


def test_load_without_file_returns_defaults():
    assert user_settings.load() == user_settings.DEFAULTS


def test_init_writes_defaults_when_missing(tmp_path):
    user_settings.init()
    settings_path = tmp_path / "settings.json"
    assert settings_path.exists()
    assert json.loads(settings_path.read_text()) == user_settings.DEFAULTS


def test_init_does_not_overwrite_existing_file(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps({"custom": True}))
    user_settings.init()
    assert json.loads(settings_path.read_text()) == {"custom": True}


def test_save_then_load_roundtrips():
    user_settings.save({"footer_signals": {"default": ["temp"]}})
    assert user_settings.load() == {"footer_signals": {"default": ["temp"]}}


def test_load_with_invalid_json_returns_defaults(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text("{not valid json")
    assert user_settings.load() == user_settings.DEFAULTS
