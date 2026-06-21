"""
cfg.py — Typed configuration registry for drivecheck.

Each config property is declared with register(), carrying its default,
type, UI metadata, and an optional on_changed callback. The YAML file is
just a persistent overlay — loading it applies values silently (no
callbacks). Callbacks only fire on explicit cfg.set() calls, which happen
after the app is fully initialised.

Usage in a module:

    import cfg

    cfg.register("collector.scan_interval",
        default=300, type="int", label="Scan interval",
        section="Collector", description="Seconds between drive scans.",
        min=10, max=3600, restart_required=True,
    )

    # After the relevant object is constructed, wire live-applicable props:
    cfg.register("logging.level",
        ..., restart_required=False,
        on_changed=lambda v: logging.getLogger().setLevel(v.upper()),
    )

Retrieving a value:

    interval = cfg.get("collector.scan_interval")

See also: GET /api/config, PATCH /api/config in app.py.
"""
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

logger = logging.getLogger(__name__)

# Round-trip mode (the ruamel.yaml default) preserves comments and formatting
# across load -> save, unlike PyYAML which discards them on parse.
_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.width = 4096  # don't wrap long values/comments
_yaml.indent(mapping=2, sequence=4, offset=2)  # matches config.yaml's existing style


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ConfigProp:
    key: str
    default: object
    type: str              # "int" | "float" | "str" | "bool" | "enum" | "list"
    label: str
    section: str
    description: str           # short, always shown below the control
    tooltip: str | None = None # longer explanation, shown on hover only
    min: float | None = None
    max: float | None = None
    choices: list[str] | None = None   # required when type == "enum"
    restart_required: bool = True
    on_changed: Callable | None = field(default=None, repr=False)


# ---------------------------------------------------------------------------
# Internal state
# ---------------------------------------------------------------------------

_props:  dict[str, ConfigProp] = {}            # registered props, keyed by dotted path
_values: dict[str, object]    = {}             # current values (defaults overlaid by YAML)
_raw:    CommentedMap          = CommentedMap()  # parsed YAML, comments/formatting intact


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def register(
    key: str,
    *,
    default: object,
    type: str,
    label: str,
    section: str,
    description: str,
    tooltip: str | None = None,
    min: float | None = None,
    max: float | None = None,
    choices: list[str] | None = None,
    restart_required: bool = True,
    on_changed: Callable | None = None,
) -> None:
    """Declare a config property. Call at module level before cfg.load()."""
    _props[key] = ConfigProp(
        key=key, default=default, type=type, label=label, section=section,
        description=description, tooltip=tooltip, min=min, max=max,
        choices=choices, restart_required=restart_required, on_changed=on_changed,
    )
    _values[key] = default


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------

def load(path: str | Path) -> None:
    """Overlay YAML values onto registered props. Does NOT fire callbacks."""
    global _raw
    logger.info("loading config: %s", path)
    try:
        with open(path) as f:
            _raw = _yaml.load(f) or CommentedMap()
    except FileNotFoundError:
        logger.warning("config file not found: %s — using defaults", path)
        _raw = CommentedMap()
        return

    flat = _flatten(_raw)
    for key, value in flat.items():
        if key in _props:
            try:
                coerced = _coerce(value, _props[key])
                _validate(coerced, _props[key])
                _values[key] = coerced
            except (ValueError, TypeError) as e:
                logger.warning("config: ignoring invalid value for %s: %s", key, e)
        # Unregistered keys (probe chains, etc.) stay in _raw for save()


def save(path: str | Path) -> None:
    """Persist current values to YAML in place, preserving comments/formatting
    and any unregistered keys."""
    logger.info("saving config: %s", path)
    for key, value in _values.items():
        parts = key.split(".")
        d = _raw
        for part in parts[:-1]:
            if part not in d or not isinstance(d[part], dict):
                d[part] = CommentedMap()
            d = d[part]
        d[parts[-1]] = value
    with open(path, "w") as f:
        _yaml.dump(_raw, f)


# ---------------------------------------------------------------------------
# Get / set
# ---------------------------------------------------------------------------

def get(key: str) -> object:
    """Return the current value for a registered key."""
    if key not in _props:
        raise KeyError(f"unknown config key: {key!r}")
    return _values.get(key, _props[key].default)


def set(key: str, value: object) -> bool:
    """Validate and apply a value. Fires on_changed if not restart_required.

    Returns True if a restart is required to fully apply the change.
    Raises KeyError for unknown keys, ValueError for invalid values.
    """
    prop = _props.get(key)
    if prop is None:
        raise KeyError(f"unknown config key: {key!r}")
    value = _coerce(value, prop)
    _validate(value, prop)
    _values[key] = value
    if prop.on_changed is not None and not prop.restart_required:
        prop.on_changed(value)
        logger.debug("config: %s = %r (applied live)", key, value)
    else:
        logger.debug("config: %s = %r (restart required)", key, value)
    return prop.restart_required


def apply_live() -> None:
    """Fire on_changed for every live-applicable prop with its current value.

    Call once after load() to apply loaded values that take effect without a
    restart. Any future live prop registered in any module is picked up here
    automatically — no per-module init calls needed.
    """
    for key, prop in _props.items():
        if prop.on_changed is not None and not prop.restart_required:
            value = _values.get(key, prop.default)
            prop.on_changed(value)
            logger.debug("config: %s = %r (applied live on startup)", key, value)


def set_many(updates: dict[str, object]) -> list[str]:
    """Apply multiple key/value pairs atomically (all-or-nothing validation).

    Returns a list of keys that require a restart to take full effect.
    Raises KeyError / ValueError without applying anything if any value is invalid.
    """
    # Validate all first
    coerced: dict[str, object] = {}
    for key, value in updates.items():
        prop = _props.get(key)
        if prop is None:
            raise KeyError(f"unknown config key: {key!r}")
        coerced[key] = _coerce(value, prop)
        _validate(coerced[key], prop)

    # Apply
    restart_keys: list[str] = []
    for key, value in coerced.items():
        if set(key, value):
            restart_keys.append(key)
    return restart_keys


# ---------------------------------------------------------------------------
# API serialisation
# ---------------------------------------------------------------------------

def props() -> list[dict]:
    """Return all registered props with current values — used by GET /api/config."""
    return [
        {
            "key":              p.key,
            "label":            p.label,
            "section":          p.section,
            "description":      p.description,
            "tooltip":          p.tooltip,
            "type":             p.type,
            "value":            _values.get(p.key, p.default),
            "default":          p.default,
            "min":              p.min,
            "max":              p.max,
            "choices":          p.choices,
            "restart_required": p.restart_required,
        }
        for p in _props.values()
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _flatten(d: dict, prefix: str = "") -> dict[str, object]:
    result: dict[str, object] = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            result.update(_flatten(v, key))
        else:
            result[key] = v
    return result


def _coerce(value: object, prop: ConfigProp) -> object:
    if value is None:
        return None
    t = prop.type
    try:
        if t == "int":
            return int(value)
        if t == "float":
            return float(value)
        if t == "bool":
            if isinstance(value, str):
                return value.lower() in ("true", "1", "yes")
            return bool(value)
        if t in ("str", "enum"):
            return str(value)
        if t == "list":
            return [str(item) for item in value]
    except (ValueError, TypeError) as e:
        raise ValueError(f"{prop.key}: cannot coerce {value!r} to {t}: {e}") from e
    return value


def _validate(value: object, prop: ConfigProp) -> None:
    if value is None:
        return
    if prop.type == "list":
        if not isinstance(value, list):
            raise ValueError(f"{prop.key}: must be a list, got {value!r}")
        return
    if prop.min is not None and value < prop.min:
        raise ValueError(f"{prop.key}: {value} is below minimum {prop.min}")
    if prop.max is not None and value > prop.max:
        raise ValueError(f"{prop.key}: {value} exceeds maximum {prop.max}")
    if prop.choices is not None and value not in prop.choices:
        raise ValueError(f"{prop.key}: {value!r} must be one of {prop.choices}")

