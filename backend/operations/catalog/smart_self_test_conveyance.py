"""
operations.catalog.smart_self_test_conveyance — SMART conveyance self-test.

A quick check (~5 minutes) designed to detect damage that may have occurred
during drive transportation. ATA-only — SAS/NVMe drives do not implement this
test type (see AtaReader.test_types).
"""

from drives.tools.smartctl import SelfTestType
from operations.catalog.smart_self_test_base import SmartSelfTestOperation


class SmartSelfTestConveyanceOperation(SmartSelfTestOperation):
    name = "SMART Self-Test (Conveyance)"
    test_type = SelfTestType.CONVEYANCE
