from flask import Flask, jsonify
from drive_tools.smartctl import scan_drives, get_serial

app = Flask(__name__)

@app.route("/api/drives")
def drives():
    paths = scan_drives()
    result = [{"device": p, "serial": get_serial(p)} for p in paths]
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)