"""
config_file.py — which YAML file cfg loads from and saves to.

First match wins:
  1. $DRIVECHECK_CONFIG — a relative path is taken from the project root, so
     the backend, the scripts and vite's TLS lookup all agree whatever their
     working directory.
  2. config.local.yaml in the project root, if it exists (gitignored) — copy
     config.yaml there to try settings without touching the tracked file.
  3. config.yaml in the project root.

The chosen file is both read and written: Settings saves go to it too.
"""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

ENV_VAR = "DRIVECHECK_CONFIG"
LOCAL_NAME = "config.local.yaml"
DEFAULT_NAME = "config.yaml"


def path() -> Path:
    override = os.environ.get(ENV_VAR)
    if override:
        return PROJECT_ROOT / Path(override).expanduser()  # absolute paths replace the root
    local = PROJECT_ROOT / LOCAL_NAME
    if local.exists():
        return local
    return PROJECT_ROOT / DEFAULT_NAME


def display_name() -> str:
    """The active file for the UI: relative to the project root when inside it."""
    p = path()
    try:
        return str(p.resolve().relative_to(PROJECT_ROOT.resolve()))
    except ValueError:
        return str(p)
