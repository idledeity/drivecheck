"""
drives.manufacturer — DriveManufacturer type and all manufacturer lookups.

Data sources (both in backend/ref/):
  manufacturers.json   — hand-curated: canonical names, short names, IEEE strings
  wwn_ouis.json        — generated: OUI hex → IEEE canonical name

At module load the two files are joined in memory: each DriveManufacturer gains
an .ouis list of the OUI hex strings that resolve to it.  All reverse maps are
built once at startup so individual lookups are O(1) or O(n-wwn_names).
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

_REF = Path(__file__).parent.parent / "ref"


@dataclass
class DriveManufacturer:
    name:      str        # canonical common name  — "Western Digital"
    short:     str        # display short name     — "WD"
    wwn_names: list[str]  # known IEEE OUI company strings
    ouis:      list[str]  = field(default_factory=list)  # hex OUI codes, e.g. "0014EE"


# ---------------------------------------------------------------------------
# Load manufacturers.json → DriveManufacturer objects
# ---------------------------------------------------------------------------

_ALL: list[DriveManufacturer] = []

for _key, _entry in json.loads((_REF / "manufacturers.json").read_text()).items():
    if not isinstance(_entry, dict) or "common" not in _entry:
        continue
    _ALL.append(DriveManufacturer(
        name      = _entry["common"],
        short     = _entry.get("short", _entry["common"]),
        wwn_names = _entry.get("wwn_names", []),
    ))

# ---------------------------------------------------------------------------
# Build reverse indexes
# ---------------------------------------------------------------------------

# name / short → manufacturer (for scsi_vendor and display name lookups)
_by_name:  dict[str, DriveManufacturer] = {m.name:  m for m in _ALL}
_by_short: dict[str, DriveManufacturer] = {m.short: m for m in _ALL}

# IEEE canonical name → manufacturer
# Pass 1: exact match  (case-insensitive, O(1))
_ieee_exact: dict[str, DriveManufacturer] = {}
# Pass 2: substring fallback in declaration order (preserves HGST-before-Hitachi, etc.)
_ieee_substrings: list[tuple[str, DriveManufacturer]] = []

for _mfr in _ALL:
    for _wn in _mfr.wwn_names:
        _nl = _wn.lower()
        _ieee_exact.setdefault(_nl, _mfr)
        _ieee_substrings.append((_nl, _mfr))


def _resolve_ieee(ieee_name: str) -> DriveManufacturer | None:
    lower = ieee_name.lower()
    mfr = _ieee_exact.get(lower)
    if mfr:
        return mfr
    for substr, mfr in _ieee_substrings:
        if substr in lower:
            return mfr
    return None


# OUI int → manufacturer  (O(1))
_by_oui: dict[int, DriveManufacturer] = {}

for _hex, _ieee_name in json.loads((_REF / "wwn_ouis.json").read_text()).items():
    _mfr = _resolve_ieee(_ieee_name)
    if _mfr:
        _oui_int = int(_hex, 16)
        _by_oui[_oui_int] = _mfr
        _mfr.ouis.append(_hex)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def from_oui(oui: int | None) -> DriveManufacturer | None:
    """Look up a manufacturer by IEEE OUI integer (as returned by smartctl wwn.oui)."""
    if oui is None:
        return None
    return _by_oui.get(oui)


def from_ieee_name(ieee_name: str | None) -> DriveManufacturer | None:
    """Resolve an IEEE OUI canonical company string to a DriveManufacturer.

    Tries exact match first, then substring (wwn_name appears inside ieee_name).
    Useful for resolving SCSI vendor strings and wwn_ouis.json values.
    """
    if not ieee_name:
        return None
    return _resolve_ieee(ieee_name)


def from_name(name: str | None) -> DriveManufacturer | None:
    """Look up by canonical common name or short name (case-sensitive)."""
    if not name:
        return None
    return _by_name.get(name) or _by_short.get(name)


def all_manufacturers() -> list[DriveManufacturer]:
    """Return all known manufacturers in declaration order."""
    return list(_ALL)
