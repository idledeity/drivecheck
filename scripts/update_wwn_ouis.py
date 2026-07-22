"""
scripts/update_wwn_ouis.py — Regenerate backend/ref/wwn_ouis.json from the
IEEE OUI database.

Usage:
    python scripts/update_wwn_ouis.py               # fetch from IEEE
    python scripts/update_wwn_ouis.py /path/oui.txt # use local copy

The output is committed to the repo. Re-run this script when the IEEE file
is updated or when new storage vendors need to be included.

To add a manufacturer: edit backend/ref/manufacturers.json — this script
reads that file and derives all matching rules from it.

Source: https://standards-oui.ieee.org/oui/oui.txt
"""

import json
import re
import subprocess
import sys
from pathlib import Path

IEEE_URL = "https://standards-oui.ieee.org/oui/oui.txt"
_REF = Path(__file__).parent.parent / "backend" / "ref"
OUT_PATH = _REF / "wwn_ouis.json"

_MFR_DATA: dict[str, dict] = json.loads((_REF / "manufacturers.json").read_text())

# Pre-build lookup structures from manufacturers.json.
# Pass 1: exact match (case-insensitive)
_exact: set[str] = set()      # lowercase ieee names that match exactly
# Pass 2: substring match — checked in declaration order so more-specific
#         manufacturers (HGST) beat broader ones (Western Digital, Hitachi).
_substrings: list[str] = []   # lowercase wwn_names in declaration order

for _key, _entry in _MFR_DATA.items():
    if not isinstance(_entry, dict) or "common" not in _entry:
        continue
    for _name in _entry.get("wwn_names", []):
        _nl = _name.lower()
        _exact.add(_nl)
        _substrings.append(_nl)


def normalize(company: str) -> str | None:
    """Return the company name unchanged if it belongs to a known storage manufacturer.

    The returned string (the exact IEEE canonical name) is what gets stored in
    wwn_ouis.json; manufacturers.json is the authority for resolving it to a
    common or short display name at runtime.
    """
    lower = company.lower()
    if lower in _exact:
        return company
    for substr in _substrings:
        if substr in lower:
            return company
    return None


def parse_oui_txt(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    # Only the "(base 16)" lines carry the canonical 6-hex OUI
    pattern = re.compile(r"^([0-9A-F]{6})\s+\(base 16\)\s+(.+)$", re.MULTILINE)
    for m in pattern.finditer(text):
        oui, company = m.group(1), m.group(2).strip()
        vendor = normalize(company)
        if vendor:
            result[oui] = vendor
    return dict(sorted(result.items()))


def main() -> None:
    if len(sys.argv) > 1:
        src = Path(sys.argv[1])
        print(f"Reading {src} ...", flush=True)
        text = src.read_text(encoding="latin-1")
    else:
        print(f"Fetching {IEEE_URL} ...", flush=True)
        result = subprocess.run(
            ["curl", "-sL", "--max-time", "30", IEEE_URL],
            capture_output=True, check=True,
        )
        text = result.stdout.decode("latin-1")

    ouis = parse_oui_txt(text)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(ouis, indent=2) + "\n")

    # Group by common name for the summary using the same two-pass match logic.
    def _common_for(ieee_name: str) -> str:
        lower = ieee_name.lower()
        if lower in _exact:
            # find the entry whose wwn_name exactly matches
            for _k, _e in _MFR_DATA.items():
                if not isinstance(_e, dict):
                    continue
                if any(n.lower() == lower for n in _e.get("wwn_names", [])):
                    return _e["common"]
        for substr in _substrings:
            if substr in lower:
                for _k, _e in _MFR_DATA.items():
                    if not isinstance(_e, dict):
                        continue
                    if any(n.lower() == substr for n in _e.get("wwn_names", [])):
                        return _e["common"]
        return ieee_name

    by_vendor: dict[str, int] = {}
    for ieee_name in ouis.values():
        common = _common_for(ieee_name)
        by_vendor[common] = by_vendor.get(common, 0) + 1

    print(f"Wrote {len(ouis)} OUIs to {OUT_PATH}")
    for vendor, count in sorted(by_vendor.items()):
        print(f"  {vendor}: {count}")


if __name__ == "__main__":
    main()
