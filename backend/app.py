from flask import Flask, jsonify
from probes.scan.smartctl_scan import run as scan_drives

app = Flask(__name__)

@app.route("/api/drives")
def drives():
    descriptors = scan_drives()
    result = [{"device": d.device_name, "access_type": d.access_type, "info_name": d.info_name} for d in descriptors]
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)