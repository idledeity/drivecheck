from flask import Flask, jsonify
from config import CONFIG
from models import DriveType
from probes.scan.smartctl_scan import run as scan_drives
from probes.traits.smartctl_traits import run as fetch_traits

app = Flask(__name__)

@app.route("/api/drives")
def drives():
    descriptors = scan_drives()
    result = []
    for d in descriptors:
        traits = fetch_traits(d)
        result.append({
            "device": d.device_name,
            "access_type": d.access_type,
            "info_name": d.info_name,
            "serial": traits.serial,
            "model": traits.model,
            "capacity_bytes": traits.capacity_bytes,
            "drive_type": traits.drive_type.value if traits.drive_type else None,
            "form_factor": traits.form_factor,
            "rpm": traits.rpm,
            "bus": traits.bus,
        })
    return jsonify(result)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--reload", action="store_true", default=False)
    args = parser.parse_args()

    server_cfg = CONFIG["server"]
    app.run(
        host=server_cfg["host"],
        port=server_cfg["port"],
        debug=server_cfg["debug"],
        use_reloader=args.reload,
    )