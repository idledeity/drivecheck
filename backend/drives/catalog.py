"""
drives.catalog — drive model family and white-label lookups.

Data source: backend/ref/drive_models.json — hand-curated, community-extensible
mappings for drives not covered by smartctl's own database.
"""

import json
from pathlib import Path

_REF = Path(__file__).parent.parent / "ref"
_DRIVE_MODELS: dict[str, dict] = json.loads((_REF / "drive_models.json").read_text())


def lookup_drive_model(model: str | None) -> dict | None:
    """Look up a drive model number in the community drive catalog.

    Supports exact matches and prefix matches (keys ending in '*').
    Returns the entry dict or None if not found.
    """
    if not model:
        return None
    if model in _DRIVE_MODELS:
        return _DRIVE_MODELS[model]
    for key, info in _DRIVE_MODELS.items():
        if key.endswith("*") and model.startswith(key[:-1]):
            return info
    return None
