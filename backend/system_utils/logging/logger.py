"""
logger.py — Logging configuration for drivecheck.

Call setup_from_config() once at startup, before cfg.load() — it reads
logging.level/file via cfg.peek() (a direct, one-off disk read) rather than
cfg.get(), specifically so logging is already configured by the time
cfg.load() runs and tries to log through it. cfg.apply_live() then applies
the configured level via the on_changed callback registered here —
redundant with setup()'s own call to _apply_level, but harmless.

Each module gets its own named logger via the standard library:

    import logging
    logger = logging.getLogger(__name__)
"""
import copy
import enum
import logging
from pathlib import Path

from settings import cfg

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------

class LogLevel(enum.IntEnum):
    """The application's log severity categories, low → high.

    This is the single definition of what the categories are — anything
    that needs to rank, parse, or list severities (cfg's choices below,
    log_utils.py's backend filtering, ...) should go through this enum
    rather than keeping its own name/rank table.

    Values are the app's own ordinal scale, not borrowed from the standard
    library — deliberately, so this stays our own concept rather than a
    transparent alias for logging.DEBUG/INFO/etc. Use to_stdlib()/
    from_stdlib() at the boundary with the standard logging module.
    """
    DEBUG = 0
    INFO = 1
    WARNING = 2
    ERROR = 3
    CRITICAL = 4

    def to_stdlib(self) -> int:
        """This category's equivalent standard-library logging level."""
        return getattr(logging, self.name)

    @classmethod
    def from_stdlib(cls, levelno: int) -> "LogLevel | None":
        """Resolve a standard-library level number (e.g. logging.WARNING) to a category."""
        return cls.__members__.get(logging.getLevelName(levelno))

    @classmethod
    def from_name(cls, name: str) -> "LogLevel | None":
        """Resolve a level name to its category, or None if unrecognized.

        Case-insensitive, and tolerant of the abbreviated forms _ABBREV
        below actually writes into the log text ("WARN", "CRIT") — that's
        the text anything reading the log file back has to parse, not the
        full name.
        """
        key = name.strip().upper()
        key = _ALIASES.get(key, key)
        return cls.__members__.get(key)


_FMT     = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

# Padded to a fixed 5 chars so log columns line up. Truncated names get one
# explicit abbreviation each, decided here — _ALIASES below derives the
# reverse lookup from this instead of keeping its own copy, so the two can't
# drift apart the way a hand-maintained alias table once did.
_ABBREV: dict[str, str] = {
    "DEBUG":    "DEBUG",
    "INFO":     "INFO ",
    "WARNING":  "WARN ",
    "ERROR":    "ERROR",
    "CRITICAL": "CRIT ",
}

_ALIASES: dict[str, str] = {
    abbrev.strip(): full for full, abbrev in _ABBREV.items() if abbrev.strip() != full
}

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _apply_level(level: str) -> None:
    lvl = LogLevel.from_name(level)
    if lvl is None:
        raise ValueError(f"unknown log level: {level!r}")

    root = logging.getLogger()
    root.setLevel(lvl.to_stdlib())
    logging.getLogger("werkzeug").setLevel(
        logging.DEBUG if root.level <= logging.DEBUG else logging.WARNING
    )

cfg.register("logging.level",
    default="info", type="enum", label="Log level",
    section="Logging",
    # CRITICAL excluded deliberately — it's not a sensible floor to set the
    # whole app to, only a category individual log calls can reach.
    choices=[lvl.name.lower() for lvl in LogLevel if lvl is not LogLevel.CRITICAL],
    description="Verbosity of application logs.",
    restart_required=False,
    on_changed=_apply_level,
)

cfg.register("logging.file",
    default="data/drivecheck.log", type="str", label="Log file",
    section="Logging",
    description="Path to the log file, or null to disable file logging.",
    restart_required=True,
)

# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

class _Formatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        r = copy.copy(record)
        r.levelname = _ABBREV.get(r.levelname, f"{r.levelname:<5}")
        return super().format(r)


def setup(level: str, file_path: str | None) -> None:
    """Configure the root logger. Call once at startup, before cfg.load()."""
    formatter = _Formatter(_FMT, datefmt=_DATEFMT)
    root = logging.getLogger()

    stderr = logging.StreamHandler()
    stderr.setFormatter(formatter)
    root.addHandler(stderr)

    if file_path:
        Path(file_path).parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(file_path, encoding="utf-8")
        fh.setFormatter(formatter)
        root.addHandler(fh)

    _apply_level(level)
    logger.info("logging initialized: level=%s file=%s", level, file_path or "disabled")


def setup_from_config(config_path: str | Path) -> None:
    """Configure the root logger by peeking logging.* straight out of
    `config_path`, before cfg.load() has run.

    Call once at startup, before cfg.load() — that's the whole point: by
    the time load() parses the same file and logs about it, the handlers
    set up here are already in place. logging.file is restart_required (no
    live on_changed path), so reading it once here is sufficient.
    """
    setup(
        level=cfg.peek("logging.level", config_path),
        file_path=cfg.peek("logging.file", config_path),
    )
