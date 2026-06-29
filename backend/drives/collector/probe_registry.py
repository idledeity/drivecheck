"""
drives.collector.probe_registry — Discovers available probe modules for the
*_probes config lists (collector.scan_probes, traits_probes, telemetry_probes,
vitals_probes), populating their `choices` so the Settings UI can offer a
pick-list instead of requiring hand-typed dotted paths.

Two sources per category:
  - native: drives/collector/probes/<category>/, the real importable package
    drive_collector.py's probes already ship in.
  - custom: <collector.custom_probes_dir>/<category>/ (default
    "<data dir>/custom_probes", relative paths resolve against the data
    dir), a user-managed drop-in location with the same
    scan/traits/telemetry/vitals split as native — each category subfolder
    gets an auto-created empty __init__.py so the custom_probes root can go
    on sys.path once and be addressed the same way as native paths
    ("<category>.<name>" instead of the full
    "drives.collector.probes.<category>.<name>").

Either way, a module only counts as a probe for a category if it defines a
top-level `run` callable taking exactly that category's expected argument
count (see CATEGORY_ARITY) — drive_collector.py's chain-execution call
sites are the source of truth for those counts. This is what keeps e.g.
vitals/block_device.py (a helper drive_collector.py imports and calls
directly, not part of the configured chain, with a one-argument `run`) out
of the vitals choices list without hardcoding an exclude list.

discover() rebuilds every category's choices from scratch each call, so
it's safe to call again later (the rescan API endpoint does exactly that,
with no restart needed) — including picking up edits to existing custom
probe files via importlib.reload(), not just newly-added ones. Native
probes aren't reloaded since they ship with the app and don't change
without a restart anyway.
"""

import importlib
import inspect
import logging
import pkgutil
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from settings import cfg
from system_utils import paths

logger = logging.getLogger(__name__)

cfg.register("collector.custom_probes_dir",
    default="custom_probes", type="str", label="Custom probes directory",
    section="Collector",
    description="Folder (with scan/traits/telemetry/vitals subfolders) scanned for user-added probe modules. Relative paths resolve against the data directory.",
    restart_required=False,
)

_NATIVE_PACKAGE = "drives.collector.probes"

# Positional-arg count each category's probe.run() is called with — see the
# module docstring above.
CATEGORY_ARITY = {
    "scan": 0,
    "traits": 1,
    "telemetry": 2,
    "vitals": 2,
}


def _custom_root() -> Path:
    """The configured custom-probes directory, resolved to an absolute path —
    same relative-or-absolute resolution as paths.data_dir() itself, just
    rooted at the data dir rather than the project root."""
    return (paths.data_dir() / cfg.get("collector.custom_probes_dir")).resolve()


def probe_key(category: str) -> str:
    return f"collector.{category}_probes"


def _ensure_on_sys_path(custom_root: Path) -> None:
    root_str = str(custom_root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _is_probe_module(module: ModuleType, expected_arity: int) -> bool:
    run = getattr(module, "run", None)
    if not callable(run):
        return False
    try:
        return len(inspect.signature(run).parameters) == expected_arity
    except (TypeError, ValueError):
        return False


def matches_category(module: ModuleType, category: str) -> bool:
    """Whether `module` is shaped like a valid probe for `category` — same
    check discover() uses to build choices, exposed for drive_collector.py
    to re-run at load time so a probe that's the wrong shape for the list
    it's configured in (e.g. a telemetry probe's path pasted into
    vitals_probes) gets caught before it ever runs, not after it throws."""
    return _is_probe_module(module, CATEGORY_ARITY[category])


@dataclass
class LoadedProbes:
    category: str
    modules: list[ModuleType]
    warnings: list[dict[str, str]]


def load_probes(dotted_paths: list[str], category: str) -> LoadedProbes:
    """Import and validate the configured probe modules for one category.

    A path that fails to import, or imports but doesn't match the
    category's run() shape (typo, a probe path from the wrong category, a
    custom probe file that's since been deleted), is logged and recorded
    in the result's .warnings rather than included in .modules —
    drive_collector.py only ever sees probes that are actually safe to call.

    Without this, a bad entry would otherwise either crash
    Collector.from_config() at startup (an unhandled ImportError, since this
    runs before the app even starts serving) or, for a signature mismatch
    that imports fine, fail silently-but-repeatedly every tick once
    probe.run() is actually called.
    """
    modules: list[ModuleType] = []
    warnings: list[dict[str, str]] = []

    def skip(path: str, reason: str) -> None:
        logger.error("skipping %s probe %r: %s", category, path, reason)
        warnings.append({"path": path, "reason": reason})

    for path in dotted_paths:
        try:
            module = importlib.import_module(path)
        except Exception as e:
            skip(path, f"failed to import: {e}")
            continue
        if not matches_category(module, category):
            skip(path, f"run() signature doesn't match {category} probes")
            continue
        modules.append(module)
    logger.debug("loaded %s probe module(s): %s", category, ", ".join(m.__name__ for m in modules) or "none")
    return LoadedProbes(category=category, modules=modules, warnings=warnings)


def _scan_native(category: str) -> list[str]:
    package_name = f"{_NATIVE_PACKAGE}.{category}"
    try:
        package = importlib.import_module(package_name)
    except ImportError:
        logger.warning("probe_registry: no native package %s", package_name)
        return []

    found = []
    for module_info in sorted(pkgutil.iter_modules(package.__path__), key=lambda m: m.name):
        dotted = f"{package_name}.{module_info.name}"
        try:
            module = importlib.import_module(dotted)
        except Exception as e:
            logger.warning("probe_registry: failed to import %s: %s", dotted, e)
            continue
        if _is_probe_module(module, CATEGORY_ARITY[category]):
            found.append(dotted)
        else:
            # Expected for same-directory helpers like vitals/block_device.py
            # (called directly by drive_collector.py, not part of the
            # configured chain) — debug, not warning, since this is routine.
            logger.debug("probe_registry: %s doesn't match the %s probe signature, skipping", dotted, category)
    return found


def _ensure_custom_category_dir(custom_root: Path, category: str) -> Path:
    category_dir = custom_root / category
    category_dir.mkdir(parents=True, exist_ok=True)
    init_file = category_dir / "__init__.py"
    if not init_file.exists():
        init_file.touch()
    return category_dir


def _scan_custom(custom_root: Path, category: str) -> list[str]:
    category_dir = _ensure_custom_category_dir(custom_root, category)
    _ensure_on_sys_path(custom_root)

    found = []
    for module_info in sorted(pkgutil.iter_modules([str(category_dir)]), key=lambda m: m.name):
        dotted = f"{category}.{module_info.name}"
        try:
            # User-edited files need a real reload (not the cached import)
            # for a rescan to actually pick up their latest changes.
            if dotted in sys.modules:
                module = importlib.reload(sys.modules[dotted])
            else:
                module = importlib.import_module(dotted)
        except Exception as e:
            logger.warning("probe_registry: failed to import custom probe %s: %s", dotted, e)
            continue
        if _is_probe_module(module, CATEGORY_ARITY[category]):
            found.append(dotted)
        else:
            logger.debug("probe_registry: %s doesn't match the %s probe signature, skipping", dotted, category)
    return found


def discover() -> None:
    """(Re)scan native + custom probe directories and update each *_probes
    prop's `choices` accordingly. Call once at startup, and again any time
    the rescan API endpoint is hit.

    Logs at info level (not debug) since this is the only way to confirm
    what got found/skipped without manually flipping the app into debug
    logging — the default config.yaml level is "info".
    """
    logger.info("probe discovery: scanning native + custom probe directories...")
    custom_root = _custom_root()
    for category in CATEGORY_ARITY:
        native = _scan_native(category)
        custom = _scan_custom(custom_root, category)
        cfg.set_choices(probe_key(category), native + custom)
        logger.info(
            "probe discovery: %s -> %d native, %d custom: %s",
            category, len(native), len(custom), ", ".join(native + custom) or "none",
        )


class ProbeWriteError(Exception):
    """A user-facing validation failure from write_probe_file — the message
    is safe to return to the client as-is."""


_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def custom_probe_path(category: str, name: str) -> Path:
    return _ensure_custom_category_dir(_custom_root(), category) / f"{name}.py"


def write_probe_file(category: str, name: str, content: bytes) -> None:
    """Write `content` as custom_probes/<category>/<name>.py, then import it
    and verify it actually matches `category`'s run() shape before keeping
    it. Deletes the file (and clears any sys.modules entry, so a later
    write reusing the same name can't accidentally resolve to this failed
    attempt's cached import) and raises ProbeWriteError if validation fails
    — so a bad upload/template never lingers as a broken choice.

    Used by both the upload and template endpoints — they only differ in
    where `content` comes from (a posted file vs. a generated template).

    Note: importing necessarily executes the file's top-level code before
    any of this validation runs. That's the same trust model every other
    custom probe already gets at discovery time, not a new exposure — but
    worth being explicit that this writes and runs arbitrary code the
    caller provides, with no sandboxing.
    """
    if category not in CATEGORY_ARITY:
        raise ProbeWriteError(f"unknown probe category: {category!r}")
    if not _NAME_RE.fullmatch(name):
        raise ProbeWriteError("name must be a valid Python identifier (letters, digits, underscore)")
    dest = custom_probe_path(category, name)
    if dest.exists():
        raise ProbeWriteError(f"{name}.py already exists in custom_probes/{category}/")

    _ensure_on_sys_path(_custom_root())
    dest.write_bytes(content)
    dotted = f"{category}.{name}"
    try:
        module = importlib.import_module(dotted)
        ok = matches_category(module, category)
        reason = None if ok else f"run() signature doesn't match {category} probes"
    except Exception as e:
        ok, reason = False, f"failed to import: {e}"
    if not ok:
        sys.modules.pop(dotted, None)
        dest.unlink(missing_ok=True)
        raise ProbeWriteError(reason)


# One stub per category, written verbatim (just {name}-formatted) by the
# template endpoint — correctly-shaped from the start (matches its
# category's run() arity) so a probe created from a template is always a
# safe no-op to add to the live chain immediately, before it's been filled in.
PROBE_TEMPLATES: dict[str, str] = {
    "scan": '''"""
custom_probes.scan.{name} — custom scan probe.

Runs as part of collector.scan_probes to discover attached drives.
"""

from drives.drive_models import DriveDescriptor


def run() -> list[DriveDescriptor]:
    # TODO: implement — return one DriveDescriptor per drive this probe finds.
    return []
''',
    "traits": '''"""
custom_probes.traits.{name} — custom traits probe.

Runs as part of collector.traits_probes for each discovered drive.
"""

from drives.drive_models import DriveDescriptor, DriveTraits


def run(descriptor: DriveDescriptor) -> DriveTraits:
    # TODO: implement — only non-None fields here override earlier probes
    # in the chain (see _merge_traits in drive_collector.py).
    return DriveTraits()
''',
    "telemetry": '''"""
custom_probes.telemetry.{name} — custom telemetry probe.

Runs as part of collector.telemetry_probes on each telemetry poll.
"""

from drives.drive_models import DriveContext, DriveSnapshot


def run(snapshot: DriveSnapshot, context: DriveContext) -> DriveSnapshot:
    # TODO: implement — enrich and return the snapshot.
    return snapshot
''',
    "vitals": '''"""
custom_probes.vitals.{name} — custom vitals probe.

Runs as part of collector.vitals_probes on each vitals poll.
"""

from drives.drive_models import DriveState, DriveVitals


def run(vitals: DriveVitals, state: DriveState) -> DriveVitals:
    # TODO: implement — enrich and return vitals.
    return vitals
''',
}
