import pytest

from drives.drive_models import DriveContext
from operations import logged_process

_REAL_BLOCK_DEVICE_PATH = DriveContext.block_device_path


@pytest.fixture(autouse=True)
def device_is_the_descriptor_path(monkeypatch):
    """Operation tests run real dd/badblocks/shred against image files, named by
    descriptor.device_name. Make that path the operation's target, and make the
    pre-run "serial still resolves to this block device" check pass (both sides
    None) without lsblk. Tests of the real targeting use real_block_device_path.
    """
    monkeypatch.setattr(DriveContext, "block_device_path", property(lambda self: self.descriptor.device_name))
    monkeypatch.setattr(logged_process, "resolve_block_device", lambda _serial: None)


@pytest.fixture
def real_block_device_path(monkeypatch):
    """Undo device_is_the_descriptor_path's override of DriveContext.block_device_path."""
    monkeypatch.setattr(DriveContext, "block_device_path", _REAL_BLOCK_DEVICE_PATH)
