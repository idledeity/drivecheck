import atexit
import functools
import json
import logging
import os
import subprocess
import sys
import threading
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.serving import make_server
from werkzeug.utils import secure_filename
from settings import cfg
from system_utils.logging import logger as _log
from system_utils.logging import log_utils
from system_utils import auth, origin_guard, tls
from drives.collector.drive_collector import Collector
from drives.collector import probe_registry
from operations import job_logs
from operations.operation import ParamError
from operations.operation_registry import OPERATIONS, discover as discover_operations
from recipes.recipe import Check, RecipeError
from recipes.recipe_registry import RECIPES, discover as discover_recipes
from jobs.job_registry import JobRegistry
from jobs.job_models import JobStatus
from analysis.health import score_signals
from analysis.stored_facts import snapshot_extras
from analysis.drive_history import RANGES as HISTORY_RANGES, build_history
from analysis.smart_attributes import judge_report
from analysis.smart_detail import build_smart_detail
from analysis.smart_delta import compare_signals
from analysis.self_tests import build_self_tests, recent_hours
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

_server = None  # set in __main__ before serve_forever(); used by _restart_process

cfg.load(_CONFIG_PATH)
cfg.apply_live()
discover_operations()
discover_recipes()  # after operations: recipes name them
probe_registry.discover()

collector = Collector.from_config()
job_registry = JobRegistry.from_config(
    get_context=collector.get_drive_context,
    capture_smart=collector.capture_smart,
    is_locked=collector.is_drive_locked,
)

app = Flask(__name__)
# Generous for a single probe file plus multipart overhead — no other
# endpoint needs a request body anywhere near this size. Flask returns 413
# automatically for anything larger, before the body is even fully read.
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024
# Refuse POST/PUT/PATCH/DELETE from other sites' pages. JSON routes also use
# request.get_json() without force=True, so a body that isn't
# application/json gets a 415 instead of being parsed anyway.
origin_guard.install(app)
# Every other /api route needs a signed-in session; adds /api/auth/*. Over
# HTTPS the session cookie is marked Secure, so it never travels unencrypted.
auth.install(app, secure_cookie=tls.enabled())


@app.errorhandler(415)
def _unsupported_media_type(_e):
    return jsonify({"error": "request body must be JSON (Content-Type: application/json)"}), 415


def _health_json(health) -> dict:
    return {
        "health_pct": health.health_pct,
        "health_status": health.health_status,
        "factors": health.factors,
        "floor": health.floor,
    }


def _with_judgements(snapshot: dict | None, report: dict | None = None) -> dict | None:
    """A stored snapshot summary plus what its signals mean: per-signal
    ok/warn/crit flags and the health score with its factors. Derived when
    served, never stored, so every snapshot is judged by the current rules.
    Replaces any health stored by older versions. report: the raw report the
    signals came from, for the drive's own statements in it; when not given,
    the one snapshot_id points at (if still kept) is looked up."""
    if not snapshot or "signals" not in snapshot:
        return snapshot
    if report is None:
        report = snapshot_extras(snapshot.get("snapshot_id"), snapshot.get("captured_at"))
    health = score_signals(snapshot["signals"], report)
    return {**snapshot, "signal_flags": health.signal_flags, "health": _health_json(health)}


def _smart_summary(before: dict | None, after: dict | None) -> dict:
    """A job's condensed before/after SMART summaries plus their comparison.
    The full reports are fetched separately via GET /api/jobs/<id>/smart."""
    return {
        "before": _with_judgements(before),
        "after": _with_judgements(after),
        "comparison": compare_signals((before or {}).get("signals"), (after or {}).get("signals")),
    }


def _job_summary(operation: str, status: str, result: dict | None) -> str | None:
    """The operation's one-line outcome for a completed job (see OperationBase.summarize).
    None for other statuses — the UI shows the error or status there instead."""
    op_cls = OPERATIONS.get(operation)
    if op_cls is None or status != JobStatus.COMPLETED.value or not result:
        return None
    try:
        return op_cls.summarize(result)
    except Exception:
        # Typically a result stored by an older version of the operation. Catch
        # everything: one unreadable row must not fail the whole jobs/history list.
        logger.warning("could not summarize %s result %r", operation, result, exc_info=True)
        return None


def _job_settings(operation: str, params: dict) -> list[dict]:
    """A job's params as {name, label, value}, labelled like the Run Task form
    (label None if the operation or param is no longer known)."""
    op_cls = OPERATIONS.get(operation)
    labels = {p.name: p.label for p in op_cls.params} if op_cls else {}
    return [{"name": k, "label": labels.get(k), "value": v} for k, v in params.items()]


def _job_logs(job_id: str, summary_log: str | None) -> dict:
    """Which of a job's logs exist, with their sizes (GET /api/jobs/<id>/logs/<kind>).
    The summary's text is included too, for showing inline: it is small (see
    job_logs.SUMMARY_MAX_BYTES), unlike the raw log."""
    return {
        "raw": job_logs.raw_log_info(job_id),
        "summary": (
            {"size": len(summary_log.encode("utf-8")), "text": summary_log} if summary_log is not None else None
        ),
    }


def _step_check(check: dict | None) -> dict | None:
    """A step's stored check with a readable description, or None."""
    if check is None:
        return None
    try:
        description = Check.from_dict(check).describe()
    except Exception:
        # A kind no longer registered (e.g. a debug recipe's, debug now off).
        description = check.get("kind")
    return {**check, "description": description}


def _batch_info(batch_id: str | None, step: int | None, batches: dict) -> dict | None:
    """The batch a job is a step of, for grouping it in the UI, or None for a
    standalone job. batches: db.get_batches() for the jobs being served."""
    if batch_id is None:
        return None
    batch = batches.get(batch_id)
    recipe_cls = RECIPES.get(batch.recipe) if batch else None
    return {
        "id": batch_id,
        "step": step,
        "recipe": batch.recipe if batch else None,
        "recipe_name": recipe_cls.name if recipe_cls else (batch.recipe if batch else None),
        "params": batch.params if batch else None,
        "stop_on_failure": batch.stop_on_failure if batch else None,
    }


def _batches_for(batch_ids) -> dict:
    return db.get_batches(sorted({b for b in batch_ids if b is not None}))


def _job_to_dict(job, batches: dict | None = None):
    if batches is None:
        batches = _batches_for([job.batch_id])
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
        "summary": _job_summary(job.operation, job.status.value, job.result),
        "settings": _job_settings(job.operation, job.params),
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "smart": _smart_summary(job.smart_before, job.smart_after),
        "logs": _job_logs(job.id, job.summary_log),
        "queue_position": job.queue_position,
        "batch": _batch_info(job.batch_id, job.batch_step, batches),
        "step_check": _step_check(job.step_check),
    }


def _stale_after() -> dict:
    """How old (seconds) each kind of reading may get before the UI marks it
    overdue: vitals a few ticks late (the collector stalled or the drive went
    away), SMART values past two full-read intervals (reads are failing). The
    attribute read only runs while a drive is busy, so an idle drive's SMART
    values are legitimately up to one full-read interval old."""
    return {
        "vitals": max(60, 3 * cfg.get("collector.poll_intervals.vitals")),
        "smart": 2 * cfg.get("collector.poll_intervals.snapshot"),
    }


def _self_test_coverage(rows: list[dict], power_on_hours, recent: dict, latest_read_at: str | None) -> dict:
    view = build_self_tests(rows, power_on_hours, recent, latest_read_at)
    return {k: view[k] for k in ("latest", "hours_reset", "log_seen_at", "log_missing")}


@app.route("/api/drives")
def drives():
    collector.wait_for_scan()
    stale_after = _stale_after()
    states = collector.get_drive_states()
    self_tests = db.get_self_tests([s.context.guid for s in states])
    recent = recent_hours()
    result = []
    for state in states:
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
            # What dd/badblocks/shred target (e.g. /dev/sdb); None if unresolved.
            "block_device": ctx.block_device_path,
            "serial": traits.serial,
            "manufacturer": traits.manufacturer,
            "manufacturer_short": traits.manufacturer_short,
            "white_label": traits.white_label,
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
            "crc_errors": signals.crc_errors,
            "load_unload_cycles": signals.load_unload_cycles,
            "smart_passed": signals.smart_passed,
            "link_errors": signals.link_errors,
            "data_written": signals.data_written,
            "data_read": signals.data_read,
            "health_pct": health.health_pct,
            "health_status": health.health_status,
            "signal_flags": health.signal_flags,
            "health_factors": health.factors,
            "health_floor": health.floor,
            "last_polled_at": polled_at.isoformat() if polled_at else None,
            "last_full_read_at": collector.last_full_read_at(ctx.guid),
            # Coverage, not health: the latest finished self-test of each kind
            # seen in the drive's log, kept past its rollover (analysis.self_tests).
            "self_test_coverage": _self_test_coverage(
                self_tests[ctx.guid], signals.power_on_hours, recent, collector.last_full_read_at(ctx.guid)),
            "stale_after_s": stale_after,
            "is_mounted": state.attachment.is_mounted,
            "label": state.label,
            "locked": state.locked,
            "first_seen": state.first_seen,
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
    body = request.get_json() or {}
    if "label" not in body and "locked" not in body:
        return jsonify({"error": "missing 'label' or 'locked'"}), 400

    result = {"guid": guid}

    if "label" in body:
        label = body["label"]
        if label is not None and not isinstance(label, str):
            return jsonify({"error": "'label' must be a string or null"}), 400
        if isinstance(label, str):
            label = label.strip() or None
        if not collector.set_drive_label(guid, label):
            return jsonify({"error": "unknown drive"}), 404
        result["label"] = label

    if "locked" in body:
        locked = body["locked"]
        if not isinstance(locked, bool):
            return jsonify({"error": "'locked' must be a boolean"}), 400
        if not collector.set_drive_locked(guid, locked):
            return jsonify({"error": "unknown drive"}), 404
        result["locked"] = locked

    return jsonify(result)


@app.route("/api/drives/history")
def drives_history():
    """Chart history for one or more drives: guids (comma-separated, required),
    range (one of HISTORY_RANGES, default 24h). See analysis.drive_history."""
    guids = list(dict.fromkeys(_csv_arg("guids") or []))
    if not guids:
        return jsonify({"error": "'guids' must list at least one drive"}), 400
    range_key = request.args.get("range", "24h")
    if range_key not in HISTORY_RANGES:
        return jsonify({"error": f"'range' must be one of {', '.join(HISTORY_RANGES)}"}), 400

    def describe_job(row):
        op_cls = OPERATIONS.get(row["operation"])
        return {
            "operation_name": op_cls.name if op_cls else row["operation"],
            "summary": _job_summary(row["operation"], row["status"], _json_or_none(row["result_json"])),
            "error": row["error"],
        }

    return jsonify(build_history(guids, range_key, describe_job=describe_job))


@app.route("/api/drives/<guid>/raw/latest")
def drive_raw_snapshot_latest(guid):
    row = db.get_latest_raw_snapshot(guid)
    if row is None:
        return jsonify(None), 404
    return jsonify({
        "captured_at": row["captured_at"],
        "probe": row["probe"],
        "raw": judge_report(json.loads(row["raw_json"])),
    })


@app.route("/api/drives/<guid>/smart/detail")
def drive_smart_detail(guid):
    """The Health Report and SMART page for a drive's latest stored full
    smartctl read, as one point in time: the read's signals with their flags
    and health score, its named fields, the full attribute table / counter
    logs, the drive's self-test log, and every self-test DriveCheck has seen
    in it (self_tests, analysis.self_tests). detail is null when the read holds no
    smartctl output; signals (and flags, health) when it was stored without
    them (an older version)."""
    row = db.get_latest_raw_snapshot(guid)
    if row is None:
        return jsonify(None), 404
    report = json.loads(row["raw_json"])
    raw = judge_report(report)
    smartctl = raw.get("smartctl")
    judged = _with_judgements({"signals": raw["signals"]}, report) if raw.get("signals") else {}
    return jsonify({
        "captured_at": row["captured_at"],
        "probe": row["probe"],
        "signals": judged.get("signals"),
        "signal_flags": judged.get("signal_flags"),
        "health": judged.get("health"),
        "detail": build_smart_detail(smartctl) if smartctl else None,
        "self_test_log": raw.get("self_test_log", []),
        "self_tests": build_self_tests(
            db.get_self_tests([guid])[guid], (raw.get("signals") or {}).get("power_on_hours"),
            latest_read_at=row["captured_at"]),
    })


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(user_settings.load())


@app.route("/api/settings", methods=["PATCH"])
def patch_settings():
    updates = request.get_json()
    if not isinstance(updates, dict):
        return jsonify({"error": "body must be a JSON object"}), 400
    current = user_settings.load()
    current.update(updates)
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
                "destructive": op_cls.destructive,
                "params": [asdict(p) for p in op_cls.params],
            })
    return jsonify(result)


@app.route("/api/jobs", methods=["GET"])
def list_jobs():
    jobs = job_registry.list_jobs()
    batches = _batches_for(j.batch_id for j in jobs)
    return jsonify([_job_to_dict(j, batches) for j in jobs])


def _history_row_to_dict(row, batches: dict):
    op_cls = OPERATIONS.get(row["operation"])
    params = json.loads(row["params_json"])
    result = _json_or_none(row["result_json"])
    return {
        "id": row["id"],
        "drive_guid": row["drive_guid"],
        "operation": row["operation"],
        "operation_name": op_cls.name if op_cls else row["operation"],
        "category": row["category"],
        "params": params,
        "status": row["status"],
        # Terminal jobs have no live progress — shape matches _job_to_dict's
        # own fallback so the frontend can reuse the same Job type/rendering.
        "progress": {"percent": None, "message": None, "eta_seconds": None},
        "result": result,
        "summary": _job_summary(row["operation"], row["status"], result),
        "settings": _job_settings(row["operation"], params),
        "error": row["error"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "smart": _smart_summary(_json_or_none(row["smart_before_json"]), _json_or_none(row["smart_after_json"])),
        "logs": _job_logs(row["id"], row["summary_log"]),
        "batch": _batch_info(row["batch_id"], row["batch_step"], batches),
        "step_check": _step_check(_json_or_none(row["step_check_json"])),
    }


def _json_or_none(text):
    return json.loads(text) if text else None


def _csv_arg(name: str) -> list[str] | None:
    """A comma-separated query arg as a list, or None when it's absent."""
    raw = request.args.get(name)
    return None if raw is None else [v for v in raw.split(",") if v]


@app.route("/api/jobs/history")
def job_history():
    """Stored jobs, most recently finished first. Every filter is optional:
    guid (one or more, comma-separated; none = every drive), since (ISO time,
    jobs finished at or after it), status, operation, exclude_category (each
    comma-separated), limit (default 50, at most 500)."""
    try:
        limit = int(request.args.get("limit", 50))
    except ValueError:
        return jsonify({"error": "'limit' must be a whole number"}), 400
    since = request.args.get("since")
    if since is not None:
        try:
            since = datetime.fromisoformat(since).isoformat()
        except ValueError:
            return jsonify({"error": "'since' must be an ISO date or time"}), 400
    statuses = _csv_arg("status")
    known = {s.value for s in JobStatus}
    if statuses and not set(statuses) <= known:
        return jsonify({"error": f"unknown status: {', '.join(sorted(set(statuses) - known))}"}), 400
    rows = db.get_job_history(
        _csv_arg("guid"), max(1, min(limit, 500)), since=since, statuses=statuses,
        operations=_csv_arg("operation"), exclude_categories=_csv_arg("exclude_category"),
    )
    batches = _batches_for(r["batch_id"] for r in rows)
    return jsonify([_history_row_to_dict(r, batches) for r in rows])


@app.route("/api/jobs", methods=["POST"])
def create_jobs():
    body = request.get_json() or {}
    guids = body.get("guids")
    operation = body.get("operation")
    params = body.get("params", {})
    if not guids or not operation:
        return jsonify({"error": "missing 'guids' or 'operation'"}), 400
    if not isinstance(params, dict):
        return jsonify({"error": "'params' must be an object"}), 400

    op_cls = OPERATIONS.get(operation)
    if op_cls is None:
        return jsonify({"error": "unknown operation"}), 404

    if op_cls.destructive:
        locked_guids = [g for g in guids if collector.is_drive_locked(g)]
        if locked_guids:
            return jsonify({
                "error": "one or more drives are locked",
                "locked_guids": locked_guids,
            }), 423

    try:
        jobs = job_registry.create_jobs(guids, operation, params)
    except ParamError as e:
        return jsonify({"error": f"invalid parameter '{e.field}': {e.message}", "field": e.field}), 400
    if jobs is None:
        return jsonify({"error": "unknown operation"}), 404
    return jsonify([_job_to_dict(j) for j in jobs]), 201


def _full_report(summary: dict | None) -> dict | None:
    """The full raw SMART report a summary points at, judged, or None if there is
    none (capture failed) or it was pruned (collector.keep_job_snapshots off)."""
    snapshot_id = (summary or {}).get("snapshot_id")
    if snapshot_id is None:
        return None
    row = db.get_raw_snapshot(snapshot_id)
    return judge_report(json.loads(row["raw_json"]), summary.get("signals")) if row else None


@app.route("/api/jobs/<job_id>/smart")
def job_smart(job_id):
    """A job's before/after SMART summaries, comparison, and full reports
    (smart_attributes, self_test_log, raw smartctl -a JSON)."""
    summaries = db.get_job_smart(job_id)
    if summaries is None:
        return jsonify({"error": "unknown job"}), 404
    before, after = summaries
    return jsonify({
        **_smart_summary(before, after),
        "reports": {"before": _full_report(before), "after": _full_report(after)},
    })


@app.route("/api/jobs/<job_id>/logs/<kind>")
def job_log(job_id, kind):
    """A job's raw program output (kind "raw", a file) or the summary of its
    important lines stored with the job ("summary"), as plain text. 404 if the
    job has no such log."""
    if kind == "summary":
        summary = db.get_job_summary_log(job_id)
        if summary is None:
            return jsonify({"error": "no summary log for this job"}), 404
        return Response(summary, mimetype="text/plain")  # Flask adds charset=utf-8
    path = job_logs.existing_raw_log(job_id) if kind == "raw" else None
    if path is None:
        return jsonify({"error": f"no {kind} log for this job"}), 404
    # Not cached: a running job's raw log keeps growing.
    return send_file(path, mimetype="text/plain", max_age=0)


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def cancel_job(job_id):
    if not job_registry.cancel_job(job_id):
        return jsonify({"error": "unknown or already-finished job"}), 404
    return jsonify({"status": "ok"})


@app.route("/api/jobs/<job_id>/move", methods=["POST"])
def move_job(job_id):
    """Move a queued job one place earlier ("up") or later ("down") among its
    drive's queued jobs."""
    direction = {"up": -1, "down": 1}.get((request.get_json() or {}).get("direction"))
    if direction is None:
        return jsonify({"error": "'direction' must be \"up\" or \"down\""}), 400
    job = job_registry.get_job(job_id)
    if job is not None and job.batch_id is not None:
        return jsonify({"error": "this job is a step of a batch — move the batch instead",
                        "batch_id": job.batch_id}), 409
    moved = job_registry.move_job(job_id, direction)
    if moved is None:
        return jsonify({"error": "unknown job, or it is no longer queued"}), 404
    if not moved:
        return jsonify({"error": "already first or last among this drive's queued jobs "
                                 "(a batch that has started stays first)"}), 409
    return jsonify({"status": "ok"})


def _recipe_to_dict(key: str, recipe_cls) -> dict:
    return {
        "key": key,
        "name": recipe_cls.name,
        "description": recipe_cls.description,
        "destructive": recipe_cls.destructive,
        "stop_on_failure": recipe_cls.stop_on_failure,
        "params": [asdict(p) for p in recipe_cls.params],
    }


@app.route("/api/recipes")
def list_recipes():
    """Every recipe, with its params. Which drives it suits, and what each
    would run, comes from POST /api/batches/preview."""
    return jsonify([_recipe_to_dict(key, recipe_cls) for key, recipe_cls in RECIPES.items()])


def _batch_request():
    """(guids, recipe key, params, stop_on_failure) from a batch request body,
    or a 400 response."""
    body = request.get_json() or {}
    guids, recipe, params = body.get("guids"), body.get("recipe"), body.get("params", {})
    stop_on_failure = body.get("stop_on_failure")
    if not guids or not recipe:
        return None, (jsonify({"error": "missing 'guids' or 'recipe'"}), 400)
    if not isinstance(params, dict):
        return None, (jsonify({"error": "'params' must be an object"}), 400)
    if stop_on_failure is not None and not isinstance(stop_on_failure, bool):
        return None, (jsonify({"error": "'stop_on_failure' must be true or false"}), 400)
    return (guids, recipe, params, stop_on_failure), None


def _recipe_failure(e: Exception):
    """The response for a recipe that couldn't be planned."""
    if isinstance(e, ParamError):
        return jsonify({"error": f"invalid parameter '{e.field}': {e.message}", "field": e.field}), 400
    logger.error("recipe plan is invalid: %s", e)
    return jsonify({"error": f"the recipe's plan is invalid: {e}"}), 500


@app.route("/api/batches/preview", methods=["POST"])
def preview_batches():
    """What POST /api/batches would queue, without queueing it: for each drive,
    the steps with the settings each would use, or why the drive is left out.
    Same body as POST /api/batches."""
    parsed, error = _batch_request()
    if error:
        return error
    guids, recipe_key, params, stop_on_failure = parsed
    try:
        planned = job_registry.plan_batches(guids, recipe_key, params)
    except (ParamError, RecipeError) as e:
        return _recipe_failure(e)
    if planned is None:
        return jsonify({"error": "unknown recipe"}), 404
    merged_params, drive_plans = planned
    recipe_cls = RECIPES[recipe_key]
    return jsonify({
        "recipe": _recipe_to_dict(recipe_key, recipe_cls),
        "params": merged_params,
        "stop_on_failure": recipe_cls.stop_on_failure if stop_on_failure is None else stop_on_failure,
        "drives": [
            {
                "guid": plan.guid,
                "excluded": plan.excluded,
                # Starting a destructive recipe is refused (423) while any of its drives is locked.
                "locked": recipe_cls.destructive and collector.is_drive_locked(plan.guid),
                "steps": None if plan.steps is None else [
                    {
                        "operation": p.step.operation,
                        "operation_name": p.operation.name,
                        "destructive": p.operation.destructive,
                        "supported": p.supported,
                        "settings": _job_settings(p.step.operation, p.params),
                        "check": _step_check(p.step.check.to_dict() if p.step.check else None),
                    }
                    for p in plan.steps
                ],
            }
            for plan in drive_plans
        ],
    })


@app.route("/api/batches", methods=["POST"])
def create_batches():
    """Start a recipe: one batch per drive, every step queued up front. Body:
    guids, recipe, params (the recipe's), stop_on_failure (optional; the
    recipe's default if left out). Drives the recipe can't run on are left out
    (see the preview); 422 if that leaves none."""
    parsed, error = _batch_request()
    if error:
        return error
    guids, recipe_key, params, stop_on_failure = parsed
    recipe_cls = RECIPES.get(recipe_key)
    if recipe_cls is None:
        return jsonify({"error": "unknown recipe"}), 404
    if recipe_cls.destructive:
        locked_guids = [g for g in guids if collector.is_drive_locked(g)]
        if locked_guids:
            return jsonify({"error": "one or more drives are locked", "locked_guids": locked_guids}), 423
    try:
        created = job_registry.create_batches(guids, recipe_key, params, stop_on_failure)
    except (ParamError, RecipeError) as e:
        return _recipe_failure(e)
    if created is None:
        return jsonify({"error": "unknown recipe"}), 404
    if not created:
        return jsonify({"error": f"none of the selected drives can run {recipe_cls.name}"}), 422
    batches = {batch.id: batch for batch, _ in created}
    return jsonify([
        {"id": batch.id, "drive_guid": batch.drive_guid, "jobs": [_job_to_dict(j, batches) for j in jobs]}
        for batch, jobs in created
    ]), 201


@app.route("/api/batches/<batch_id>/cancel", methods=["POST"])
def cancel_batch(batch_id):
    """Cancel a batch's queued steps and stop its running one."""
    cancelled = job_registry.cancel_batch(batch_id)
    if cancelled is None:
        return jsonify({"error": "unknown batch"}), 404
    return jsonify({"status": "ok", "cancelled": cancelled})


@app.route("/api/batches/<batch_id>/move", methods=["POST"])
def move_batch(batch_id):
    """Move a batch's queued steps, together, one place earlier ("up") or
    later ("down") among its drive's queued jobs."""
    direction = {"up": -1, "down": 1}.get((request.get_json() or {}).get("direction"))
    if direction is None:
        return jsonify({"error": "'direction' must be \"up\" or \"down\""}), 400
    moved = job_registry.move_batch(batch_id, direction)
    if moved is None:
        return jsonify({"error": "unknown batch, or none of its steps are still queued"}), 404
    if not moved and job_registry.batch_started(batch_id):
        return jsonify({"error": "this batch has started — its remaining steps stay next on the drive"}), 409
    if not moved:
        return jsonify({"error": "already first or last among this drive's queued jobs "
                                 "(a batch that has started stays first)"}), 409
    return jsonify({"status": "ok"})


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify(cfg.props())


@app.route("/api/probes/rescan", methods=["POST"])
def rescan_probes():
    """Re-walk the native + custom probe directories and refresh the
    module_list props' suggested choices — no restart needed, since this
    only updates UI metadata, not any running collector state."""
    probe_registry.discover()
    return jsonify(cfg.props())


@app.route("/api/probes/status", methods=["GET"])
def probe_status():
    """Warnings for probe entries that failed to load at the last collector
    startup — restart_required, so this only reflects the configuration as
    of the last restart, not any unsaved or unrestarted edits."""
    return jsonify(collector.probe_warnings)


def _probe_editing_required(view):
    """403 unless collector.allow_probe_editing is on: writing a probe file
    makes the backend import and run it. The flag is file_only, so a session
    can't turn it on through PATCH /api/config."""
    @functools.wraps(view)
    def guarded(*args, **kwargs):
        if not probe_registry.editing_allowed():
            return jsonify({"error": "probe editing is off: set collector.allow_probe_editing "
                                     "to true in config.yaml and restart"}), 403
        return view(*args, **kwargs)
    return guarded


@app.route("/api/probes/template", methods=["POST"])
@_probe_editing_required
def template_probe():
    """Write a correctly-shaped stub probe file for `category`, named
    `name`, into the custom probes directory — gives a new custom probe
    the right run() signature from the start, instead of discovering a
    mismatch only after it's been written by hand."""
    data = request.get_json() or {}
    category, name = data.get("category", ""), data.get("name", "")
    template = probe_registry.PROBE_TEMPLATES.get(category, "")
    try:
        probe_registry.write_probe_file(category, name, template.format(name=name).encode())
    except probe_registry.ProbeWriteError as e:
        return jsonify({"error": str(e)}), 400
    probe_registry.discover()
    return jsonify(cfg.props())


@app.route("/api/probes/upload", methods=["POST"])
@_probe_editing_required
def upload_probe():
    """Save a posted .py file as a new custom probe for `category` — same
    write-then-validate-then-clean-up-on-failure path as the template
    endpoint, just with the file's content coming from the upload instead
    of a generated stub."""
    category = request.form.get("category", "")
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "no file provided"}), 400
    stem = Path(secure_filename(file.filename)).stem
    try:
        probe_registry.write_probe_file(category, stem, file.read())
    except probe_registry.ProbeWriteError as e:
        return jsonify({"error": str(e)}), 400
    probe_registry.discover()
    return jsonify(cfg.props())


@app.route("/api/probes/source", methods=["GET"])
def get_probe_source():
    category, path = request.args.get("category", ""), request.args.get("path", "")
    try:
        content, editable = probe_registry.read_probe_source(category, path)
    except probe_registry.ProbeLookupError as e:
        return jsonify({"error": str(e)}), 404
    return jsonify({"content": content, "editable": editable})


@app.route("/api/probes/source", methods=["PUT"])
@_probe_editing_required
def put_probe_source():
    """Overwrite a custom probe's source in place — same name and category,
    only the content changes. Native probes and not-yet-existing paths are
    rejected, both as a 400, since neither is a valid edit target."""
    data = request.get_json() or {}
    category, path, content = data.get("category", ""), data.get("path", ""), data.get("content", "")
    name = probe_registry.custom_probe_name(category, path)
    if name is None:
        return jsonify({"error": f"{path!r} is not an editable {category} probe"}), 400
    try:
        probe_registry.write_probe_file(category, name, content.encode(), overwrite=True)
    except (probe_registry.ProbeLookupError, probe_registry.ProbeWriteError) as e:
        return jsonify({"error": str(e)}), 400
    probe_registry.discover()
    return jsonify(cfg.props())


@app.route("/api/probes/source", methods=["DELETE"])
@_probe_editing_required
def delete_probe_source():
    category, path = request.args.get("category", ""), request.args.get("path", "")
    try:
        probe_registry.delete_probe_file(category, path)
    except probe_registry.ProbeLookupError as e:
        return jsonify({"error": str(e)}), 400
    probe_registry.discover()
    return jsonify(cfg.props())


@app.route("/api/probes/download", methods=["GET"])
def download_probe_source():
    category, path = request.args.get("category", ""), request.args.get("path", "")
    try:
        content, _editable = probe_registry.read_probe_source(category, path)
    except probe_registry.ProbeLookupError as e:
        return jsonify({"error": str(e)}), 404
    name = path.rsplit(".", 1)[-1]
    return Response(content, mimetype="text/x-python", headers={
        "Content-Disposition": f'attachment; filename="{name}.py"',
    })


@app.route("/api/config", methods=["PATCH"])
def patch_config():
    updates = request.get_json() or {}
    try:
        restart_required = cfg.set_many(updates)
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    cfg.save(_CONFIG_PATH)
    return jsonify({"restart_required": restart_required})


def _restart_process():
    logger.info("restarting: spawning a new backend process")
    try:
        collector.stop()
    except Exception:
        logger.exception("error stopping collector during restart")
    try:
        job_registry.shutdown()
    except Exception:
        logger.exception("error shutting down job registry during restart")
    if _server is not None:
        try:
            _server.socket.close()
        except OSError:
            pass
    # Spawn the replacement process then hard-exit the current one.  Using
    # subprocess.Popen instead of os.execv gives the new process a fresh PID
    # and a clean fd table, which avoids a debugpy "already being debugged"
    # warning on the second and subsequent restarts (os.execv reuses the PID
    # so inherited debugpy fds accumulate across restarts and confuse the
    # debug adapter).  os._exit skips atexit so collector/job_registry aren't
    # double-stopped.
    subprocess.Popen([sys.executable] + sys.argv)
    os._exit(0)


@app.route("/api/restart", methods=["POST"])
def restart_server():
    logger.info("restart requested via API")
    # Delayed so this response has time to flush back to the client before
    # the process image is replaced — running execv inline here would
    # likely cut the connection instead of returning a clean response.
    threading.Timer(0.3, _restart_process).start()
    return jsonify({"status": "restarting"})


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
    collector.wait_for_scan()
    job_registry.recover()
    atexit.register(collector.stop)
    atexit.register(job_registry.shutdown)

    host = cfg.get("server.host")
    port = args.port if args.port is not None else cfg.get("server.port")
    try:
        ssl_context = tls.certificate_files()
    except tls.TlsConfigError as e:
        logger.error("can't start with HTTPS: %s", e)
        sys.exit(1)
    scheme = "https" if ssl_context else "http"

    if args.reload:
        # Reloader mode forks a child process and can't use the make_server path.
        app.run(host=host, port=port, debug=cfg.get("server.debug"), use_reloader=True,
                ssl_context=ssl_context)
    else:
        _server = make_server(host, port, app, threaded=True, ssl_context=ssl_context)
        logger.info("serving on %s://%s:%d", scheme, host, port)
        _server.serve_forever()
