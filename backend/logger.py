"""
logger.py — Logging configuration for drivecheck.

Call setup() once at startup. After that, each module gets its own named
logger via the standard library:

    import logging
    logger = logging.getLogger(__name__)
"""
import copy
import logging
from pathlib import Path

_FMT    = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
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
    """Configure the root logger. Call once before importing modules that log at startup."""
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

    # Werkzeug logs every HTTP request at INFO; keep it quiet unless we're at DEBUG.
    if root.level > logging.DEBUG:
        logging.getLogger("werkzeug").setLevel(logging.WARNING)
