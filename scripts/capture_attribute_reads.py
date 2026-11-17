"""
Capture real `smartctl -j -A -H` output (the collector's attribute read) as a
test fixture, next to the full reads in smartctl_full_reads.json. SAS drives
get `-l error` too, as the collector's read does (their error counter log).

Run as yourself (it calls sudo smartctl):
    python3 scripts/capture_attribute_reads.py

Serial numbers, WWNs and logical unit IDs are removed. The Exos is left out:
reading an idle Exos loads its parked heads (one load/unload cycle).
"""

import json
import subprocess
import sys
from datetime import date
from pathlib import Path


def run():
    drives = [
        # (fixture key, device, -d type, SAS)
        ("hp_mb3000gcvbt",     "/dev/sdh", "sat",  False),
        ("netapp_x316_sas",    "/dev/sdc", "scsi", True),
        ("hgst_hus726060_sas", "/dev/sdi", "scsi", True),
    ]
    out = {"_source": f"smartctl -j -A -H (SAS: + -l error) on real drives, the collector's attribute "
                      f"read, captured {date.today().isoformat()}; serial numbers, WWNs and logical unit IDs removed"}
    for key, device, dev_type, sas in drives:
        args = ["sudo", "smartctl", "-j", "-A", "-H"] + (["-l", "error"] if sas else []) + ["-d", dev_type, device]
        print(" ".join(args), file=sys.stderr)
        result = subprocess.run(args, capture_output=True, text=True)
        data = json.loads(result.stdout)
        _scrub(data)
        print(f"  {data.get('model_name') or data.get('scsi_model_name') or '?'}: {sorted(data)}", file=sys.stderr)
        out[key] = data

    path = Path(__file__).resolve().parent.parent / "backend/tests/analysis/fixtures/smartctl_attribute_reads.json"
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {path}", file=sys.stderr)


_PRIVATE = {"serial_number", "wwn", "logical_unit_id"}


def _scrub(node):
    if isinstance(node, dict):
        for k in list(node):
            if k in _PRIVATE:
                del node[k]
            else:
                _scrub(node[k])
    elif isinstance(node, list):
        for child in node:
            _scrub(child)


if __name__ == "__main__":
    run()
