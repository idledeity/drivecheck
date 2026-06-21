"""
log_utils.py — Reading and severity-filtering drivecheck's own log output.

Used by the /api/logs route in app.py to serve recent log entries to the
frontend's Settings → Logs tab.
"""
import csv
import io
import logging
import os
import re
import subprocess
from pathlib import Path

from settings import cfg
from system_utils.logging.logger import LogLevel

logger = logging.getLogger(__name__)

_LOG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([A-Z ]{5})\] ([\w.]+): (.+)$"
)


def read_log_lines(max_lines: int | None = None) -> list[str] | None:
    """Return raw log lines from the best available source.

    Preference: log file (complete history across restarts) → journald
    (current invocation, only available when running as a systemd service).
    Returns None if neither source is available.

    max_lines caps both sources to their last N lines: journalctl via its
    `-n` flag, the log file by slicing after reading it (it still has to
    read the whole file first — there's no seek-from-the-end equivalent for
    text lines — but callers are capped to the same result either way). The
    app doesn't currently pass max_lines, so both sources return their full
    available history.
    """
    log_path = cfg.get("logging.file")
    if log_path:
        try:
            lines = Path(log_path).read_text(encoding="utf-8").splitlines()
            logger.debug("read %d log line(s) from %s", len(lines), log_path)
            return lines[-max_lines:] if max_lines is not None else lines
        except FileNotFoundError:
            logger.debug("log file not found: %s — falling back to journald", log_path)

    # Detect systemd: JOURNAL_STREAM is set by systemd on service processes.
    if os.environ.get("JOURNAL_STREAM"):
        cmd = ["journalctl", f"_PID={os.getpid()}", "--output=cat", "--no-pager"]
        if max_lines is not None:
            cmd.append(f"-n{max_lines}")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                lines = result.stdout.splitlines()
                logger.debug("read %d log line(s) from journald", len(lines))
                return lines
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.warning("journalctl unavailable: %s", e)

    logger.warning("no log source available (logging.file unset and not running under systemd)")
    return None


def filter_log_records(lines: list[str], limit: int | None, min_level: str) -> list[dict]:
    """Parse raw log lines and return the last `limit` entries at or above `min_level`.

    min_level of "all" (or anything LogLevel doesn't recognize) means no
    filter — every parsed line passes. limit of None means no cap — used by
    the export route, which wants the complete matching history rather than
    the display page's last-N.
    """
    min_lvl = LogLevel.from_name(min_level)

    # No severity filter and a real cap: matches are exactly the last `limit`
    # raw lines, so skip parsing anything further back. Otherwise (a filter
    # is active, or there's no cap at all) the full available history has to
    # be scanned.
    candidates = lines if (min_lvl is not None or limit is None) else lines[-limit:]

    records = []
    for line in candidates:
        m = _LOG_RE.match(line)
        if m:
            level_name = m.group(2).strip()
            lvl = LogLevel.from_name(level_name)
            if min_lvl is None or (lvl is not None and lvl >= min_lvl):
                records.append({
                    "timestamp": m.group(1),
                    # Normalized to the full canonical name (e.g. "critical",
                    # not the abbreviated "crit" _ABBREV wrote to the file) —
                    # that's the one vocabulary the frontend's level styling
                    # actually matches against.
                    "level": lvl.name.lower() if lvl else level_name.lower(),
                    "logger": m.group(3),
                    "message": m.group(4),
                })
    return records[-limit:] if limit is not None else records


def format_as_text(records: list[dict]) -> str:
    """Render records back into the same line format the log file itself uses."""
    return "\n".join(
        f"{r['timestamp']} [{r['level'].upper():<5}] {r['logger']}: {r['message']}"
        for r in records
    )


def format_as_csv(records: list[dict]) -> str:
    """Render records as CSV. csv.DictWriter handles quoting for us — log
    messages can contain commas or embedded newlines (e.g. a multi-line
    traceback), and naive string-joining would produce a broken file."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=["timestamp", "level", "logger", "message"])
    writer.writeheader()
    writer.writerows(records)
    return buf.getvalue()
