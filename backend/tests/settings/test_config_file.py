from settings import config_file


def _root(monkeypatch, tmp_path):
    monkeypatch.setattr(config_file, "PROJECT_ROOT", tmp_path)
    monkeypatch.delenv(config_file.ENV_VAR, raising=False)


def test_defaults_to_config_yaml(monkeypatch, tmp_path):
    _root(monkeypatch, tmp_path)
    assert config_file.path() == tmp_path / "config.yaml"


def test_local_file_wins_when_present(monkeypatch, tmp_path):
    _root(monkeypatch, tmp_path)
    (tmp_path / "config.local.yaml").write_text("")
    assert config_file.path() == tmp_path / "config.local.yaml"


def test_env_var_wins_over_local_file(monkeypatch, tmp_path):
    _root(monkeypatch, tmp_path)
    (tmp_path / "config.local.yaml").write_text("")
    monkeypatch.setenv(config_file.ENV_VAR, "other.yaml")
    assert config_file.path() == tmp_path / "other.yaml"


def test_env_var_absolute_path(monkeypatch, tmp_path):
    _root(monkeypatch, tmp_path)
    target = tmp_path / "elsewhere" / "x.yaml"
    monkeypatch.setenv(config_file.ENV_VAR, str(target))
    assert config_file.path() == target


def test_display_name_relative_inside_root(monkeypatch, tmp_path):
    _root(monkeypatch, tmp_path)
    (tmp_path / "config.local.yaml").write_text("")
    assert config_file.display_name() == "config.local.yaml"


def test_display_name_absolute_outside_root(monkeypatch, tmp_path):
    _root(monkeypatch, tmp_path / "root")
    target = tmp_path / "x.yaml"
    monkeypatch.setenv(config_file.ENV_VAR, str(target))
    assert config_file.display_name() == str(target)
