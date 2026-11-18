"""
recipes.recipe_registry — Recipe registry.

All recipes available to the Jobs system, keyed by a stable string (the
module name under recipes/catalog/) used in the API and persisted on Batch
rows. Populated by discover(); call it once at startup, after
operations.operation_registry.discover(). To add a recipe, drop a module into
recipes/catalog/ — no registration step needed.
"""

import importlib
import inspect
import logging
import pkgutil

from recipes.recipe import Recipe

logger = logging.getLogger(__name__)

RECIPES: dict[str, type[Recipe]] = {}


def discover() -> None:
    """Populate RECIPES by scanning recipes.catalog."""
    found: dict[str, type[Recipe]] = {}
    package = importlib.import_module("recipes.catalog")
    for module_info in sorted(pkgutil.iter_modules(package.__path__), key=lambda m: m.name):
        module = importlib.import_module(f"recipes.catalog.{module_info.name}")
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

    RECIPES.clear()
    RECIPES.update(found)
    logger.info("%d recipe(s) loaded: %s", len(RECIPES), ", ".join(RECIPES) or "none")
