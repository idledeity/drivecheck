import json
import logging
import os
import tempfile
from pathlib import Path

from system_utils import paths

logger = logging.getLogger(__name__)

DEFAULTS: dict = {
    "footer_signals": {
        "default": ["power_on_hours", "reallocated", "pending",            "uncorrected"],
        "SAS":     ["power_on_hours", "reallocated", "load_unload_cycles", "uncorrected"],
    }
}


def _settings_path() -> Path:
    return paths.data_dir() / "settings.json"


def init() -> None:
    if not _settings_path().exists():
        logger.info("no user settings file found — writing defaults: %s", _settings_path())
        save(dict(DEFAULTS))


def load() -> dict:
    try:
        return json.loads(_settings_path().read_text())
    except FileNotFoundError:
        logger.debug("user settings file not found — using defaults")
        return dict(DEFAULTS)
    except json.JSONDecodeError as e:
        logger.warning("user settings file is invalid JSON — using defaults: %s", e)
        return dict(DEFAULTS)


def save(data: dict) -> None:
    logger.info("saving user settings: %s", _settings_path())
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise
