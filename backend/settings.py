import json
import os
import tempfile
from pathlib import Path

import cfg


def _settings_path() -> Path:
    """Resolved at call time, not import time — cfg.get() needs cfg.load() to
    have already run, which isn't guaranteed at settings.py's own import time."""
    return (Path(__file__).parent.parent / cfg.get("data.dir") / "settings.json").resolve()


DEFAULTS: dict = {
    "footer_signals": {
        "default": ["power_on_hours", "reallocated", "pending",            "uncorrected"],
        "SAS":     ["power_on_hours", "reallocated", "load_unload_cycles", "uncorrected"],
    }
}


def init() -> None:
    if not _settings_path().exists():
        save(dict(DEFAULTS))


def load() -> dict:
    try:
        return json.loads(_settings_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(DEFAULTS)


def save(data: dict) -> None:
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
