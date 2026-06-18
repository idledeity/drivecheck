import atexit
import json
import logging
import re
from dataclasses import asdict
from pathlib import Path

from flask import Flask, jsonify, request
from config import CONFIG
import cfg
import logger as _log

_log_cfg = CONFIG.get("logging", {})
_log.setup(level=_log_cfg.get("level", "info"), file_path=_log_cfg.get("file"))
cfg.load(Path(__file__).parent.parent / "config.yaml")
cfg.apply_live()

logger = logging.getLogger(__name__)

from collector import Collector
from operations.registry import OPERATIONS
from job_registry import JobRegistry
from job_models import JobStatus
import db
import settings

_collector_cfg = CONFIG["collector"]
collector = Collector(
    scan_interval=_collector_cfg["scan_interval"],
    poll_intervals=_collector_cfg["poll_intervals"],
    scan_probes=_collector_cfg["scan_probes"],
    traits_probes=_collector_cfg["traits_probes"],
    telemetry_probes=_collector_cfg["telemetry_probes"],
    vitals_probes=_collector_cfg["vitals_probes"],
    keep_history_days=_collector_cfg["keep_history_days"],
    max_workers=_collector_cfg["max_workers"],
    probe_timeout=_collector_cfg["probe_timeout"],
)

_jobs_cfg = CONFIG["jobs"]
job_registry = JobRegistry(
    max_parallel=_jobs_cfg.get("max_parallel"),
    get_context=collector.get_drive_context,
)

app = Flask(__name__)


def _job_to_dict(job):
    progress = job_registry.get_progress(job.id) if job.status == JobStatus.RUNNING else None
    return {
        "id": job.id,
        "drive_guid": job.drive_guid,
        "operation": job.operation,
        "operation_name": OPERATIONS[job.operation].name,
        "category": job.category,
        "params": job.params,
        "status": job.status.value,
        "progress": asdict(progress) if progress else {"percent": None, "message": None, "eta_seconds": None},
        "result": job.result,
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@app.route("/api/drives")
def drives():
    collector.wait_for_scan()
    result = []
    for state in collector.get_drive_states():
        ctx = state.context
        traits = state.traits
        signals = state.snapshot.telemetry.signals
        health = state.snapshot.health
        polled_at = state.snapshot.telemetry.last_polled_at
        vitals = state.vitals
        result.append({
            "guid": ctx.guid,
            "device": ctx.descriptor.device_name,
            "info_name": ctx.descriptor.info_name,
            "serial": traits.serial,
            "manufacturer": traits.manufacturer,
            "model": traits.model,
            "capacity_bytes": traits.capacity_bytes,
            "drive_type": traits.drive_type.value if traits.drive_type else None,
            "form_factor": traits.form_factor,
            "rpm": traits.rpm,
            "bus": traits.bus,
            "power_on_hours": signals.power_on_hours,
            "temp": signals.temp,
            "reallocated": signals.reallocated,
            "pending": signals.pending,
            "uncorrected": signals.uncorrected,
            "load_unload_cycles": signals.load_unload_cycles,
            "smart_passed": signals.smart_passed,
            "health_status": health.health_status,
            "signal_flags": health.signal_flags,
            "last_polled_at": polled_at.isoformat() if polled_at else None,
            "is_mounted": state.attachment.is_mounted,
            "label": state.label,
            "vitals": {
                "temp": vitals.temp,
                "temp_source": vitals.temp_source,
                "captured_at": vitals.captured_at.isoformat() if vitals.captured_at else None,
                "io": {
                    "read_iops": vitals.io.read_iops,
                    "write_iops": vitals.io.write_iops,
                    "read_bytes_per_sec": vitals.io.read_bytes_per_sec,
                    "write_bytes_per_sec": vitals.io.write_bytes_per_sec,
                    "busy_pct": vitals.io.busy_pct,
                },
            },
        })
    return jsonify(result)


@app.route("/api/drives/<guid>", methods=["PATCH"])
def patch_drive(guid):
    body = request.get_json(force=True) or {}
    if "label" not in body:
        return jsonify({"error": "missing 'label'"}), 400

    label = body["label"]
    if label is not None and not isinstance(label, str):
        return jsonify({"error": "'label' must be a string or null"}), 400
    if isinstance(label, str):
        label = label.strip() or None

    if not collector.set_drive_label(guid, label):
        return jsonify({"error": "unknown drive"}), 404
    return jsonify({"guid": guid, "label": label})


@app.route("/api/drives/<guid>/raw/latest")
def drive_raw_snapshot_latest(guid):
    row = db.get_latest_raw_snapshot(guid)
    if row is None:
        return jsonify(None), 404
    return jsonify({
        "captured_at": row["captured_at"],
        "probe": row["probe"],
        "raw": json.loads(row["raw_json"]),
    })


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(settings.load())


@app.route("/api/settings", methods=["PATCH"])
def patch_settings():
    current = settings.load()
    current.update(request.get_json(force=True))
    settings.save(current)
    return jsonify(current)


@app.route("/api/drives/refresh", methods=["POST"])
def drives_refresh():
    body = request.get_json(silent=True) or {}
    guids = body.get("guids")
    if not collector.trigger_poll(guids):
        return jsonify({"error": "unknown drive"}), 404
    return jsonify({"status": "ok"})


@app.route("/api/drives/scan", methods=["POST"])
def drives_scan():
    collector.trigger_scan()
    return jsonify({"status": "ok"})


@app.route("/api/operations")
def list_operations():
    guids = [g for g in request.args.get("guids", "").split(",") if g]
    contexts = [collector.get_drive_context(g) for g in guids]
    contexts = [c for c in contexts if c is not None]
    if not contexts:
        return jsonify([])

    result = []
    for key, op_cls in OPERATIONS.items():
        if all(op_cls.supports(c) for c in contexts):
            result.append({
                "key": key,
                "name": op_cls.name,
                "category": op_cls.category,
                "tool": op_cls.tool,
                "params": [asdict(p) for p in op_cls.params],
            })
    return jsonify(result)


@app.route("/api/jobs", methods=["GET"])
def list_jobs():
    return jsonify([_job_to_dict(j) for j in job_registry.list_jobs()])


@app.route("/api/jobs", methods=["POST"])
def create_jobs():
    body = request.get_json(force=True) or {}
    guids = body.get("guids")
    operation = body.get("operation")
    params = body.get("params", {})
    if not guids or not operation:
        return jsonify({"error": "missing 'guids' or 'operation'"}), 400

    jobs = job_registry.create_jobs(guids, operation, params)
    if jobs is None:
        return jsonify({"error": "unknown operation"}), 404
    return jsonify([_job_to_dict(j) for j in jobs]), 201


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def cancel_job(job_id):
    if not job_registry.cancel_job(job_id):
        return jsonify({"error": "unknown or already-finished job"}), 404
    return jsonify({"status": "ok"})


_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"

@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify(cfg.props())


@app.route("/api/config", methods=["PATCH"])
def patch_config():
    updates = request.get_json(force=True) or {}
    try:
        restart_required = cfg.set_many(updates)
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    cfg.save(_CONFIG_PATH)
    return jsonify({"restart_required": restart_required})


_LOG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([A-Z ]{5})\] ([\w.]+): (.+)$"
)


def _read_log_lines(limit: int) -> list[str] | None:
    """Return the most recent log lines from the best available source.

    Preference: log file (complete history across restarts) → journald
    (current invocation, only available when running as a systemd service).
    Returns None if neither source is available.
    """
    log_path = CONFIG.get("logging", {}).get("file")
    if log_path:
        try:
            return Path(log_path).read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            pass

    # Detect systemd: JOURNAL_STREAM is set by systemd on service processes.
    import os, subprocess
    if os.environ.get("JOURNAL_STREAM"):
        try:
            result = subprocess.run(
                ["journalctl", f"_PID={os.getpid()}", f"-n{limit}",
                 "--output=cat", "--no-pager"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                return result.stdout.splitlines()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    return None


@app.route("/api/logs")
def get_logs():
    limit = min(int(request.args.get("n", 500)), 2000)
    lines = _read_log_lines(limit)
    if lines is None:
        return jsonify({"error": "no log source available — configure logging.file or run as a systemd service"}), 404
    records = []
    for line in lines[-limit:]:
        m = _LOG_RE.match(line)
        if m:
            records.append({
                "timestamp": m.group(1),
                "level": m.group(2).strip().lower(),
                "logger": m.group(3),
                "message": m.group(4),
            })
    return jsonify(records)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--reload", action="store_true", default=False)
    args = parser.parse_args()

    settings.init()
    db.init()
    logger.info(
        "drivecheck starting — %d operation(s) loaded: %s",
        len(OPERATIONS), ", ".join(OPERATIONS.keys()) or "none",
    )
    collector.start()
    atexit.register(collector.stop)
    atexit.register(job_registry.shutdown)

    server_cfg = CONFIG["server"]
    app.run(
        host=server_cfg["host"],
        port=server_cfg["port"],
        debug=server_cfg["debug"],
        use_reloader=args.reload,
    )
