"""
operations.registry — Operation registry.

All operations available to the Jobs system, keyed by a stable string used
in the API and persisted on Job rows.

Auto-discovered at import time by scanning operations/catalog/ for regular
operations and operations/catalog/debug/ for debug operations (the latter
only if config.yaml: jobs.enable_debug_operations is true). To add an
operation, drop a module into the appropriate catalog directory — no
registration step needed. Shared base classes (e.g. one operation family
with a common run() split across short/long variants) can live in the same
directory too, as long as they leave at least one abstractmethod
unimplemented — inspect.isabstract() excludes them from discovery.
"""

import importlib
import inspect
import pkgutil

from config import CONFIG
from operations.operation import OperationBase


def _discover() -> dict[str, type[OperationBase]]:
    enable_debug = CONFIG["jobs"]["enable_debug_operations"]
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

    return found


OPERATIONS: dict[str, type[OperationBase]] = _discover()
