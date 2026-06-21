"""
operations.registry — Operation registry.

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
"""

import importlib
import inspect
import pkgutil

from settings import cfg
from operations.operation import OperationBase

cfg.register("jobs.enable_debug_operations",
    default=True, type="bool", label="Enable debug operations",
    section="Jobs", description="Adds debug-only operations (e.g. Sleep) for exercising the queue/scheduler.",
    restart_required=True,
)

OPERATIONS: dict[str, type[OperationBase]] = {}


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
                    found[module_info.name] = attr

    _scan("operations.catalog")
    if enable_debug:
        _scan("operations.catalog.debug")

    OPERATIONS.clear()
    OPERATIONS.update(found)
