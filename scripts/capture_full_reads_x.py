"""
Capture real `smartctl -j -x -a` output (the planned full read) as a test
fixture, next to the `-a` full reads in smartctl_full_reads.json, and time
each read against the collector's probe timeout.

Run as yourself (it calls sudo smartctl):
    python3 scripts/capture_full_reads_x.py           # HP + SAS drives
    python3 scripts/capture_full_reads_x.py --exos    # also the Exos (sde)

Serial numbers, WWNs, logical unit IDs and SAS addresses are removed. The Exos is left out
unless asked: reading an idle Exos loads its parked heads (one load/unload
cycle), so pass --exos while it is busy.
"""

import json
import subprocess
import sys
import time
from datetime import date
from pathlib import Path


def run():
    drives = [
        # (fixture key, device, -d type)
        ("hp_mb3000gcvbt",     "/dev/sdh", "sat"),
        ("netapp_x316_sas",    "/dev/sdc", "scsi"),
        ("hgst_hus726060_sas", "/dev/sdi", "scsi"),
    ]
    if "--exos" in sys.argv:
        drives.insert(0, ("exos_x16", "/dev/sde", "sat"))

    out = {"_source": f"smartctl -j -x -a on real drives, the collector's planned full read, captured "
                      f"{date.today().isoformat()}; serial numbers, WWNs, logical unit IDs and SAS addresses removed"}
    for key, device, dev_type in drives:
        args = ["sudo", "smartctl", "-j", "-x", "-a", "-d", dev_type, device]
        print(" ".join(args), file=sys.stderr)
        started = time.monotonic()
        result = subprocess.run(args, capture_output=True, text=True)
        took = time.monotonic() - started
        data = json.loads(result.stdout)
        _scrub(data)
        print(f"  exit {result.returncode}, {took:.1f}s, {len(result.stdout):,} bytes, keys: {sorted(data)}",
              file=sys.stderr)
        out[key] = data

    path = Path(__file__).resolve().parent.parent / "backend/tests/analysis/fixtures/smartctl_full_reads_x.json"
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
