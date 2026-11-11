"""
operations.operation_registry — Operation registry.

All operations available to the Jobs system, keyed by a stable string used
in the API and persisted on Job rows.

Populated by discover(), which scans operations/catalog/ for regular
operations and operations/catalog/debug/ for debug operations (the latter
only if jobs.enable_debug_operations is true). discover() must be called
once after cfg.load() — app.py does this at startup. To add an operation,
drop a module into the appropriate catalog directory — no registration step
needed. Shared base classes (e.g. one operation family with a common run()
split across short/long variants) can live in the same directory too, as
long as they leave at least one abstractmethod unimplemented —
inspect.isabstract() excludes them from discovery.

Renaming or merging a module changes its key. Job rows store the key, so the
operation lists its old ones in `former_keys` and lookups of them still
resolve (see _OperationTable).
"""

import importlib
import inspect
import logging
import pkgutil

from settings import cfg
from operations.operation import OperationBase

logger = logging.getLogger(__name__)

cfg.register("jobs.enable_debug_operations",
    default=True, type="bool", label="Enable debug operations",
    section="Jobs", description="Adds debug-only operations (e.g. Sleep) for exercising the queue/scheduler.",
    restart_required=True,
)

class _OperationTable(dict):
    """Operations by key. get() and [] also resolve former keys, so job rows
    and history from before a rename still find their operation; iterating
    lists current keys only, so former ones are never offered for new jobs."""

    def __init__(self):
        super().__init__()
        self.aliases: dict[str, str] = {}

    def __missing__(self, key: str) -> type[OperationBase]:
        if key in self.aliases:
            return self[self.aliases[key]]
        raise KeyError(key)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default


OPERATIONS: _OperationTable = _OperationTable()


def discover() -> None:
    """Populate OPERATIONS by scanning the catalog. Call once after cfg.load()."""
    enable_debug = cfg.get("jobs.enable_debug_operations")
    found: dict[str, type[OperationBase]] = {}

    def _scan(package_name: str) -> None:
        package = importlib.import_module(package_name)
        for module_info in sorted(pkgutil.iter_modules(package.__path__), key=lambda m: m.name):
            module = importlib.import_module(f"{package_name}.{module_info.name}")
            for attr in vars(module).values():
                if (
                    isinstance(attr, type)
                    and issubclass(attr, OperationBase)
                    and attr is not OperationBase
                    and attr.__module__ == module.__name__
                    and not inspect.isabstract(attr)
                ):
                    logger.debug("discovered operation '%s' -> %s", module_info.name, attr.__name__)
                    found[module_info.name] = attr

    logger.debug("scanning operations.catalog (debug operations %s)", "enabled" if enable_debug else "disabled")
    _scan("operations.catalog")
    if enable_debug:
        _scan("operations.catalog.debug")

    OPERATIONS.clear()
    OPERATIONS.update(found)
    OPERATIONS.aliases = {old: key for key, op_cls in found.items() for old in op_cls.former_keys}

    logger.info(
        "%d operation(s) loaded: %s",
        len(OPERATIONS), ", ".join(OPERATIONS.keys()) or "none",
    )
