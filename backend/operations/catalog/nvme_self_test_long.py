"""
operations.catalog.nvme_self_test_long — NVMe extended self-test.

Runs the drive's built-in extended self-test (full surface scan; duration
varies by drive capacity, typically 20–120+ minutes).
"""

from drives.tools.smartctl import SelfTestType
from operations.catalog.nvme_self_test_base import NvmeSelfTestOperation


class NvmeSelfTestLongOperation(NvmeSelfTestOperation):
    name = "NVMe Self-Test (Extended)"
    test_type = SelfTestType.LONG
