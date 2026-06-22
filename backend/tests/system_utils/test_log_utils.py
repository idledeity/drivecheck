from settings import cfg
from system_utils.logging import log_utils


def test_read_log_lines_reads_file(tmp_path, monkeypatch):
    log_file = tmp_path / "app.log"
    log_file.write_text("line1\nline2\nline3\n")
    monkeypatch.setattr(cfg, "get", lambda key: str(log_file))
    assert log_utils.read_log_lines() == ["line1", "line2", "line3"]


def test_read_log_lines_respects_max_lines(tmp_path, monkeypatch):
    log_file = tmp_path / "app.log"
    log_file.write_text("\n".join(f"line{i}" for i in range(5)))
    monkeypatch.setattr(cfg, "get", lambda key: str(log_file))
    assert log_utils.read_log_lines(max_lines=2) == ["line3", "line4"]


def test_read_log_lines_no_source_returns_none(monkeypatch):
    monkeypatch.setattr(cfg, "get", lambda key: None)
    monkeypatch.delenv("JOURNAL_STREAM", raising=False)
    assert log_utils.read_log_lines() is None


def test_read_log_lines_falls_back_to_journald_when_no_file_configured(monkeypatch):
    monkeypatch.setattr(cfg, "get", lambda key: None)
    monkeypatch.setenv("JOURNAL_STREAM", "8:12345")

    class FakeResult:
        returncode = 0
        stdout = "line1\nline2\n"

    monkeypatch.setattr(log_utils.subprocess, "run", lambda *a, **k: FakeResult())
    assert log_utils.read_log_lines() == ["line1", "line2"]


def test_read_log_lines_missing_file_falls_back_to_journald(monkeypatch):
    monkeypatch.setattr(cfg, "get", lambda key: "/nonexistent/path.log")
    monkeypatch.setenv("JOURNAL_STREAM", "8:12345")

    class FakeResult:
        returncode = 0
        stdout = "from journal\n"

    monkeypatch.setattr(log_utils.subprocess, "run", lambda *a, **k: FakeResult())
    assert log_utils.read_log_lines() == ["from journal"]


def test_filter_log_records_parses_lines_and_skips_unparseable():
    lines = [
        "2026-01-01 12:00:00 [INFO ] app.module: started",
        "2026-01-01 12:00:01 [WARN ] app.module: degraded",
        "not a log line",
    ]
    records = log_utils.filter_log_records(lines, limit=None, min_level="all")
    assert records == [
        {"timestamp": "2026-01-01 12:00:00", "level": "info", "logger": "app.module", "message": "started"},
        {"timestamp": "2026-01-01 12:00:01", "level": "warning", "logger": "app.module", "message": "degraded"},
    ]


def test_filter_log_records_applies_min_level():
    lines = [
        "2026-01-01 12:00:00 [INFO ] app: started",
        "2026-01-01 12:00:01 [ERROR] app: broke",
    ]
    records = log_utils.filter_log_records(lines, limit=None, min_level="error")
    assert [r["level"] for r in records] == ["error"]


def test_filter_log_records_respects_limit_without_a_severity_filter():
    lines = [f"2026-01-01 12:00:0{i} [INFO ] app: msg{i}" for i in range(5)]
    records = log_utils.filter_log_records(lines, limit=2, min_level="all")
    assert [r["message"] for r in records] == ["msg3", "msg4"]


def test_filter_log_records_limit_with_filter_scans_full_history():
    lines = [
        "2026-01-01 12:00:00 [INFO ] app: skip-me",
        "2026-01-01 12:00:01 [ERROR] app: keep-me-1",
        "2026-01-01 12:00:02 [INFO ] app: skip-me-too",
        "2026-01-01 12:00:03 [ERROR] app: keep-me-2",
    ]
    records = log_utils.filter_log_records(lines, limit=1, min_level="error")
    assert [r["message"] for r in records] == ["keep-me-2"]


def test_format_as_text_pads_short_level_names():
    records = [{"timestamp": "2026-01-01 12:00:00", "level": "info", "logger": "app", "message": "hi"}]
    assert log_utils.format_as_text(records) == "2026-01-01 12:00:00 [INFO ] app: hi"


def test_format_as_csv_includes_header_and_row():
    records = [{"timestamp": "2026-01-01 12:00:00", "level": "info", "logger": "app", "message": "hi"}]
    lines = log_utils.format_as_csv(records).strip().splitlines()
    assert lines[0] == "timestamp,level,logger,message"
    assert lines[1] == "2026-01-01 12:00:00,info,app,hi"
