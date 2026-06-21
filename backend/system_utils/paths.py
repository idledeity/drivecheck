"""
paths.py — The root filesystem location for drivecheck's persistent data.

data.dir (registered here) is the one user-configurable root. Everything
this app writes to disk during normal operation — the SQLite database,
user settings, and (eventually) generated reports — lives under it.
Modules that own a specific file (db.py's drivecheck.db, settings.py's
settings.json) join their own filename onto data_dir() themselves; this
module only owns the shared root, not what anyone names underneath it.
"""

from pathlib import Path

import cfg

cfg.register("data.dir",
    default="./data", type="str", label="Data directory",
    section="Data", description="Directory for the SQLite database and settings file.",
    restart_required=True,
)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def data_dir() -> Path:
    """The configured data directory, resolved to an absolute path."""
    return (_PROJECT_ROOT / cfg.get("data.dir")).resolve()
