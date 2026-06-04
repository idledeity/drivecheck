import subprocess
import json
from flask import Flask, jsonify

app = Flask(__name__)

def scan_drives():
    """Run smartctl --scan and return list of device paths."""
    result = subprocess.run(
        ["sudo", "smartctl", "--scan", "--json"],
        capture_output=True, text=True
    )
    data = json.loads(result.stdout)
    return [dev["name"] for dev in data.get("devices", [])]

def get_serial(device_path):
    """Run smartctl -i on a device and extract serial number."""
    result = subprocess.run(
        ["sudo", "smartctl", "-i", "--json", device_path],
        capture_output=True, text=True
    )
    try:
        data = json.loads(result.stdout)
        return data.get("serial_number", "unknown")
    except json.JSONDecodeError:
        return "unknown"

@app.route("/api/drives")
def drives():
    paths = scan_drives()
    result = [{"device": p, "serial": get_serial(p)} for p in paths]
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)