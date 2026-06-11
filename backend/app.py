import json

from flask import Flask, jsonify, request
from config import CONFIG
from collector import Collector
import db
import settings

collector = Collector(poll_interval=CONFIG["collector"]["poll_interval"])

app = Flask(__name__)


@app.route("/api/drives")
def drives():
    result = []
    for state in collector.get_drive_states():
        ctx = state.context
        traits = state.traits
        signals = state.snapshot.telemetry.signals
        health = state.snapshot.health
        polled_at = state.snapshot.telemetry.last_polled_at
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
        })
    return jsonify(result)


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
    collector.trigger_poll()
    return jsonify({"status": "ok"})


@app.route("/api/collector/status")
def collector_status():
    status = collector.get_status()
    last_polled = status["last_polled_at"]
    return jsonify({
        "polling": status["polling"],
        "last_polled_at": last_polled.isoformat() if last_polled else None,
    })


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--reload", action="store_true", default=False)
    args = parser.parse_args()

    settings.init()
    db.init()
    collector.start()

    server_cfg = CONFIG["server"]
    app.run(
        host=server_cfg["host"],
        port=server_cfg["port"],
        debug=server_cfg["debug"],
        use_reloader=args.reload,
    )
