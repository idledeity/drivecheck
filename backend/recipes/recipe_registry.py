"""
recipes.recipe_registry — Recipe registry.

All recipes available to the Jobs system, keyed by a stable string (the
module name under recipes/catalog/) used in the API and persisted on Batch
rows. Populated by discover(); call it once at startup, after
operations.operation_registry.discover(). To add a recipe, drop a module into
recipes/catalog/ — no registration step needed. Debug recipes, in
recipes/catalog/debug/, load only if jobs.enable_debug_operations is true.
"""

import importlib
import inspect
import logging
import pkgutil

from recipes.recipe import Recipe
from settings import cfg

logger = logging.getLogger(__name__)

RECIPES: dict[str, type[Recipe]] = {}


def discover() -> None:
    """Populate RECIPES by scanning recipes.catalog."""
    importlib.import_module("recipes.checks")  # registers the built-in check kinds
    found: dict[str, type[Recipe]] = {}

    def _scan(package_name: str) -> None:
        package = importlib.import_module(package_name)
        for module_info in sorted(pkgutil.iter_modules(package.__path__), key=lambda m: m.name):
            if module_info.ispkg:
                continue
            module = importlib.import_module(f"{package_name}.{module_info.name}")
            for attr in vars(module).values():
                if (
                    isinstance(attr, type)
                    and issubclass(attr, Recipe)
                    and attr is not Recipe
                    and attr.__module__ == module.__name__
                    and not inspect.isabstract(attr)
                ):
                    logger.debug("discovered recipe '%s' -> %s", module_info.name, attr.__name__)
                    found[module_info.name] = attr

    _scan("recipes.catalog")
    if cfg.get("jobs.enable_debug_operations"):
        _scan("recipes.catalog.debug")

    RECIPES.clear()
    RECIPES.update(found)
    logger.info("%d recipe(s) loaded: %s", len(RECIPES), ", ".join(RECIPES) or "none")
