import yaml
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"

with open(_CONFIG_PATH) as _f:
    CONFIG: dict = yaml.safe_load(_f)
