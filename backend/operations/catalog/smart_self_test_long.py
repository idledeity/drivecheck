"""
operations.catalog.smart_self_test_long — SMART extended self-test.

A full surface scan via the drive's own firmware (typically 1-4+ hours,
reported in `ata_smart_data.self_test.polling_minutes.extended`). The
thorough complement to the short test.
"""

from drives.tools.smartctl import SelfTestType
from operations.catalog.smart_self_test_base import SmartSelfTestOperation


class SmartSelfTestLongOperation(SmartSelfTestOperation):
    name = "SMART Self-Test (Extended)"
    test_type = SelfTestType.LONG
