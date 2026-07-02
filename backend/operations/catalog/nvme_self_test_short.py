"""
operations.catalog.nvme_self_test_short — NVMe short self-test.

Runs the drive's built-in short self-test (typically under 2 minutes).
"""

from drives.tools.smartctl import SelfTestType
from operations.catalog.nvme_self_test_base import NvmeSelfTestOperation


class NvmeSelfTestShortOperation(NvmeSelfTestOperation):
    name = "NVMe Self-Test (Short)"
    test_type = SelfTestType.SHORT
