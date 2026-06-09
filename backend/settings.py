import json
import os
import tempfile
from pathlib import Path

from config import CONFIG

_PATH = (Path(__file__).parent.parent / CONFIG["data"]["dir"] / "settings.json").resolve()

DEFAULTS: dict = {
    "footer_signals": {
        "default": ["power_on_hours", "reallocated", "pending",            "uncorrected"],
        "SAS":     ["power_on_hours", "reallocated", "load_unload_cycles", "uncorrected"],
    }
}


def init() -> None:
    if not _PATH.exists():
        save(dict(DEFAULTS))


def load() -> dict:
    try:
        return json.loads(_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(DEFAULTS)


def save(data: dict) -> None:
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=_PATH.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, _PATH)
    except Exception:
        os.unlink(tmp)
        raise
