"""
logger.py — Logging configuration for drivecheck.

Call setup() once at startup (before cfg.load()), then cfg.apply_live()
will apply the configured level via the on_changed callback registered here.

Each module gets its own named logger via the standard library:

    import logging
    logger = logging.getLogger(__name__)
"""
import copy
import logging
from pathlib import Path

import cfg

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _apply_level(level: str) -> None:
    root = logging.getLogger()
    root.setLevel(level.upper())
    logging.getLogger("werkzeug").setLevel(
        logging.DEBUG if root.level <= logging.DEBUG else logging.WARNING
    )

cfg.register("logging.level",
    default="info", type="enum", label="Log level",
    section="Logging", choices=["debug", "info", "warning", "error"],
    description="Verbosity of application logs.",
    restart_required=False,
    on_changed=_apply_level,
)

# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

_FMT     = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

_ABBREV: dict[str, str] = {
    "DEBUG":    "DEBUG",
    "INFO":     "INFO ",
    "WARNING":  "WARN ",
    "ERROR":    "ERROR",
    "CRITICAL": "CRIT ",
}


class _Formatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        r = copy.copy(record)
        r.levelname = _ABBREV.get(r.levelname, f"{r.levelname:<5}")
        return super().format(r)


def setup(level: str, file_path: str | None) -> None:
    """Configure the root logger. Call once before cfg.load()."""
    formatter = _Formatter(_FMT, datefmt=_DATEFMT)

    root = logging.getLogger()
    root.setLevel(level.upper())

    stderr = logging.StreamHandler()
    stderr.setFormatter(formatter)
    root.addHandler(stderr)

    if file_path:
        Path(file_path).parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(file_path, encoding="utf-8")
        fh.setFormatter(formatter)
        root.addHandler(fh)

    logging.getLogger("werkzeug").setLevel(
        logging.DEBUG if root.level <= logging.DEBUG else logging.WARNING
    )
