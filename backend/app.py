from flask import Flask, jsonify
from config import CONFIG
from probes.scan.smartctl_scan import run as scan_drives

app = Flask(__name__)

@app.route("/api/drives")
def drives():
    descriptors = scan_drives()
    result = [{"device": d.device_name, "access_type": d.access_type, "info_name": d.info_name} for d in descriptors]
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