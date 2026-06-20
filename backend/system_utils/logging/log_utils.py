"""
log_utils.py — Reading and severity-filtering drivecheck's own log output.

Used by the /api/logs route in app.py to serve recent log entries to the
frontend's Settings → Logs tab.
"""
import os
import re
import subprocess
from pathlib import Path

from config import CONFIG
from system_utils.logging.logger import LogLevel

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
    log_path = CONFIG.get("logging", {}).get("file")
    if log_path:
        try:
            lines = Path(log_path).read_text(encoding="utf-8").splitlines()
            return lines[-max_lines:] if max_lines is not None else lines
        except FileNotFoundError:
            pass

    # Detect systemd: JOURNAL_STREAM is set by systemd on service processes.
    if os.environ.get("JOURNAL_STREAM"):
        cmd = ["journalctl", f"_PID={os.getpid()}", "--output=cat", "--no-pager"]
        if max_lines is not None:
            cmd.append(f"-n{max_lines}")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return result.stdout.splitlines()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    return None


def filter_log_records(lines: list[str], limit: int, min_level: str) -> list[dict]:
    """Parse raw log lines and return the last `limit` entries at or above `min_level`.

    min_level of "all" (or anything LogLevel doesn't recognize) means no
    filter — every parsed line passes.
    """
    min_lvl = LogLevel.from_name(min_level)

    # No severity filter: matches are exactly the last `limit` raw lines, so
    # skip parsing anything further back. With a filter, matches can be
    # sparse, so the full available history has to be scanned to find the
    # last `limit` of them.
    candidates = lines if min_lvl is not None else lines[-limit:]

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
    return records[-limit:]
