"""
Capture real `smartctl -j -A -H` output (the collector's attribute read) as a
test fixture, next to the full reads in smartctl_full_reads.json. SAS drives
get `-l error` too, as the collector's read does (their error counter log).

--extended captures the planned extended attribute read instead: ATA adds
`-l devstat -l sataphy` (device statistics, PHY event counters), SAS adds
`-l background -l sasphy` (background scan results, phy counters).

Run as yourself (it calls sudo smartctl):
    python3 scripts/capture_attribute_reads.py              # -> smartctl_attribute_reads.json
    python3 scripts/capture_attribute_reads.py --extended   # -> smartctl_attribute_reads_ext.json
    ... --exos                                              # also the Exos (sde)

Serial numbers, WWNs, logical unit IDs and SAS addresses are removed. The Exos
is left out unless asked: reading an idle Exos loads its parked heads (one
load/unload cycle), so pass --exos while it is busy.
"""

import json
import subprocess
import sys
from datetime import date
from pathlib import Path


def run():
    extended = "--extended" in sys.argv
    drives = [
        # (fixture key, device, -d type, SAS)
        ("hp_mb3000gcvbt",     "/dev/sdh", "sat",  False),
        ("netapp_x316_sas",    "/dev/sdc", "scsi", True),
        ("hgst_hus726060_sas", "/dev/sdi", "scsi", True),
    ]
    if "--exos" in sys.argv:
        drives.insert(0, ("exos_x16", "/dev/sde", "sat", False))

    command = "-A -H (SAS: + -l error" + (" -l background -l sasphy; ATA: + -l devstat -l sataphy)" if extended else ")")
    out = {"_source": f"smartctl -j {command} on real drives, the collector's {'planned extended ' if extended else ''}"
                      f"attribute read, captured {date.today().isoformat()}; serial numbers, WWNs, logical unit IDs "
                      f"and SAS addresses removed"}
    for key, device, dev_type, sas in drives:
        logs = (["-l", "error"] + (["-l", "background", "-l", "sasphy"] if extended else [])) if sas else \
               (["-l", "devstat", "-l", "sataphy"] if extended else [])
        args = ["sudo", "smartctl", "-j", "-A", "-H", *logs, "-d", dev_type, device]
        print(" ".join(args), file=sys.stderr)
        result = subprocess.run(args, capture_output=True, text=True)
        data = json.loads(result.stdout)
        _scrub(data)
        print(f"  exit {result.returncode}, {data.get('model_name') or data.get('scsi_model_name') or '?'}: "
              f"{sorted(data)}", file=sys.stderr)
        out[key] = data

    name = "smartctl_attribute_reads_ext.json" if extended else "smartctl_attribute_reads.json"
    path = Path(__file__).resolve().parent.parent / "backend/tests/analysis/fixtures" / name
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {path}", file=sys.stderr)


_PRIVATE = {"serial_number", "wwn", "logical_unit_id", "sas_address", "attached_sas_address"}


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
