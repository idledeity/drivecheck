import atexit
import json
import logging
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, request
from settings import cfg
from system_utils.logging import logger as _log
from system_utils.logging import log_utils
from drives.collector.drive_collector import Collector
from operations.operation_registry import OPERATIONS, discover as discover_operations
from jobs.job_registry import JobRegistry
from jobs.job_models import JobStatus
from database import db
from settings import user_settings

cfg.register("server.host",
    default="127.0.0.1", type="str", label="Host",
    section="Server", description="Address the Flask server binds to.",
    restart_required=True,
)
cfg.register("server.port",
    default=4343, type="int", label="Port",
    section="Server", description="Port the Flask server listens on.",
    min=1, max=65535, restart_required=True,
)
cfg.register("server.debug",
    default=False, type="bool", label="Debug mode",
    section="Server", description="Enable Flask debug mode.",
    restart_required=True,
)

_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"

# Logging has to work *before* cfg.load() runs (load() itself logs), so it's
# configured from a direct peek at the file rather than cfg.get().
_log.setup_from_config(_CONFIG_PATH)

logger = logging.getLogger(__name__)
logger.info("drivecheck starting...")

cfg.load(_CONFIG_PATH)
cfg.apply_live()
discover_operations()
logger.info(
    "%d operation(s) loaded: %s",
    len(OPERATIONS), ", ".join(OPERATIONS.keys()) or "none",
)

collector = Collector.from_config()
job_registry = JobRegistry.from_config(get_context=collector.get_drive_context)

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
    return jsonify(user_settings.load())


@app.route("/api/settings", methods=["PATCH"])
def patch_settings():
    current = user_settings.load()
    current.update(request.get_json(force=True))
    user_settings.save(current)
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


def _history_row_to_dict(row):
    op_cls = OPERATIONS.get(row["operation"])
    return {
        "id": row["id"],
        "drive_guid": row["drive_guid"],
        "operation": row["operation"],
        "operation_name": op_cls.name if op_cls else row["operation"],
        "category": row["category"],
        "params": json.loads(row["params_json"]),
        "status": row["status"],
        # Terminal jobs have no live progress — shape matches _job_to_dict's
        # own fallback so the frontend can reuse the same Job type/rendering.
        "progress": {"percent": None, "message": None, "eta_seconds": None},
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "error": row["error"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


@app.route("/api/jobs/history")
def job_history():
    guid = request.args.get("guid")
    if not guid:
        return jsonify({"error": "missing 'guid'"}), 400
    limit = min(int(request.args.get("limit", 50)), 200)
    rows = db.get_job_history(guid, limit)
    return jsonify([_history_row_to_dict(r) for r in rows])


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


@app.route("/api/logs")
def get_logs():
    limit = min(int(request.args.get("n", 500)), 2000)
    min_level = request.args.get("level", "all")

    lines = log_utils.read_log_lines()
    if lines is None:
        return jsonify({"error": "no log source available — configure logging.file or run as a systemd service"}), 404

    return jsonify(log_utils.filter_log_records(lines, limit, min_level))


@app.route("/api/logs/export")
def export_logs():
    min_level = request.args.get("level", "all")
    fmt = request.args.get("format", "txt")

    lines = log_utils.read_log_lines()
    if lines is None:
        return jsonify({"error": "no log source available — configure logging.file or run as a systemd service"}), 404

    # Uncapped — unlike get_logs() above, this wants the complete matching
    # history, not just the last `n` for display.
    records = log_utils.filter_log_records(lines, None, min_level)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    if fmt == "csv":
        body, mimetype, ext = log_utils.format_as_csv(records), "text/csv", "csv"
    else:
        body, mimetype, ext = log_utils.format_as_text(records), "text/plain", "log"

    return Response(body, mimetype=mimetype, headers={
        "Content-Disposition": f'attachment; filename="drivecheck-{stamp}.{ext}"',
    })


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--reload", action="store_true", default=False)
    parser.add_argument("--port", type=int, default=None,
        help="Override server.port for this run only (doesn't touch config.yaml)")
    args = parser.parse_args()

    user_settings.init()
    db.init()
    collector.start()
    atexit.register(collector.stop)
    atexit.register(job_registry.shutdown)

    app.run(
        host=cfg.get("server.host"),
        port=args.port if args.port is not None else cfg.get("server.port"),
        debug=cfg.get("server.debug"),
        use_reloader=args.reload,
    )
