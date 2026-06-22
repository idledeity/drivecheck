import pytest

from settings import cfg


@pytest.fixture(autouse=True)
def isolated_registry(monkeypatch):
    """cfg is a process-wide singleton — swap in copies of its internal dicts
    so register()/load()/set() in this file can't leak into other test files."""
    monkeypatch.setattr(cfg, "_props", dict(cfg._props))
    monkeypatch.setattr(cfg, "_values", dict(cfg._values))
    monkeypatch.setattr(cfg, "_raw", cfg.CommentedMap())
    monkeypatch.setattr(cfg, "_loaded", False)


def _register_test_key(**overrides):
    kwargs = dict(
        default=10, type="int", label="Test Key", section="Test",
        description="A test key.", min=0, max=100,
    )
    kwargs.update(overrides)
    cfg.register("test.key", **kwargs)


def test_register_sets_default_value():
    _register_test_key()
    assert cfg.get("test.key") == 10


def test_get_unknown_key_raises():
    with pytest.raises(KeyError):
        cfg.get("nonexistent.key")


def test_set_unknown_key_raises():
    with pytest.raises(KeyError):
        cfg.set("nonexistent.key", 1)


def test_set_validates_min_max():
    _register_test_key()
    with pytest.raises(ValueError):
        cfg.set("test.key", -1)
    with pytest.raises(ValueError):
        cfg.set("test.key", 101)


def test_set_coerces_string_to_int():
    _register_test_key()
    cfg.set("test.key", "42")
    assert cfg.get("test.key") == 42


def test_set_returns_restart_required_flag():
    _register_test_key(restart_required=True)
    assert cfg.set("test.key", 20) is True


def test_set_fires_on_changed_only_when_not_restart_required():
    calls = []
    _register_test_key(restart_required=False, on_changed=calls.append)
    cfg.set("test.key", 20)
    assert calls == [20]


def test_set_does_not_fire_on_changed_when_restart_required():
    calls = []
    _register_test_key(restart_required=True, on_changed=calls.append)
    cfg.set("test.key", 20)
    assert calls == []


def test_set_many_is_all_or_nothing():
    _register_test_key()
    cfg.register("test.other", default=1, type="int", label="Other", section="Test", description="x", max=10)
    with pytest.raises(ValueError):
        cfg.set_many({"test.key": 50, "test.other": 999})  # test.key is in range, test.other exceeds its max
    # test.key must be untouched even though it validated fine, since the batch failed overall
    assert cfg.get("test.key") == 10


def test_set_many_applies_all_on_success():
    _register_test_key()
    cfg.register("test.other", default=1, type="int", label="Other", section="Test", description="x")
    restart_keys = cfg.set_many({"test.key": 50, "test.other": 5})
    assert cfg.get("test.key") == 50
    assert cfg.get("test.other") == 5
    assert set(restart_keys) == {"test.key", "test.other"}


def test_apply_live_fires_live_props_with_current_value():
    calls = []
    _register_test_key(restart_required=False, on_changed=calls.append)
    cfg.apply_live()
    assert calls == [10]


def test_apply_live_skips_restart_required_props():
    calls = []
    _register_test_key(restart_required=True, on_changed=calls.append)
    cfg.apply_live()
    assert calls == []


def test_load_overlays_yaml_onto_defaults(tmp_path):
    _register_test_key()
    config_file = tmp_path / "config.yaml"
    config_file.write_text("test:\n  key: 77\n")
    cfg.load(config_file)
    assert cfg.get("test.key") == 77


def test_load_missing_file_keeps_defaults(tmp_path):
    _register_test_key()
    cfg.load(tmp_path / "does-not-exist.yaml")
    assert cfg.get("test.key") == 10


def test_load_ignores_invalid_values_and_keeps_default(tmp_path):
    _register_test_key()
    config_file = tmp_path / "config.yaml"
    config_file.write_text("test:\n  key: 999\n")  # exceeds max=100
    cfg.load(config_file)
    assert cfg.get("test.key") == 10


def test_load_ignores_unregistered_keys(tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text("some:\n  unregistered: 5\n")
    cfg.load(config_file)  # must not raise


def test_save_then_load_roundtrips(tmp_path):
    _register_test_key()
    cfg.set("test.key", 55)
    config_file = tmp_path / "config.yaml"
    cfg.save(config_file)
    assert "key: 55" in config_file.read_text()


def test_save_preserves_unregistered_keys(tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text("some:\n  unregistered: 5\n")
    cfg.load(config_file)
    cfg.save(config_file)
    assert "unregistered: 5" in config_file.read_text()


def test_peek_reads_directly_from_disk_before_load(tmp_path):
    _register_test_key()
    config_file = tmp_path / "config.yaml"
    config_file.write_text("test:\n  key: 33\n")
    assert cfg.peek("test.key", config_file) == 33


def test_peek_falls_back_to_default_when_file_missing(tmp_path):
    _register_test_key()
    assert cfg.peek("test.key", tmp_path / "missing.yaml") == 10


def test_peek_after_load_behaves_like_get(tmp_path):
    _register_test_key()
    cfg.set("test.key", 88)
    cfg.load(tmp_path / "irrelevant.yaml")
    assert cfg.peek("test.key", tmp_path / "irrelevant.yaml") == 88


def test_peek_unknown_key_raises(tmp_path):
    with pytest.raises(KeyError):
        cfg.peek("nonexistent.key", tmp_path / "config.yaml")


def test_props_includes_current_value_and_metadata():
    _register_test_key()
    cfg.set("test.key", 25)
    [prop] = [p for p in cfg.props() if p["key"] == "test.key"]
    assert prop["value"] == 25
    assert prop["default"] == 10
    assert prop["min"] == 0
    assert prop["max"] == 100


def test_coerce_bool_from_string():
    cfg.register("test.flag", default=False, type="bool", label="Flag", section="Test", description="x")
    cfg.set("test.flag", "true")
    assert cfg.get("test.flag") is True
    cfg.set("test.flag", "no")
    assert cfg.get("test.flag") is False


def test_validate_choices():
    cfg.register(
        "test.enum", default="a", type="enum", label="Enum", section="Test",
        description="x", choices=["a", "b"],
    )
    cfg.set("test.enum", "b")
    assert cfg.get("test.enum") == "b"
    with pytest.raises(ValueError):
        cfg.set("test.enum", "c")
