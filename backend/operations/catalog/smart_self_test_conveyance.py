"""
operations.catalog.smart_self_test_conveyance — SMART conveyance self-test.

A quick check (~5 minutes) designed to detect damage that may have occurred
during drive transportation. ATA-only — SAS/NVMe drives do not implement this
test type.
"""

from drives.drive_models import DriveContext, DriveType
from drives.tools.smartctl import SelfTestType
from operations.catalog.smart_self_test_base import SmartSelfTestOperation


class SmartSelfTestConveyanceOperation(SmartSelfTestOperation):
    name = "SMART Self-Test (Conveyance)"
    test_type = SelfTestType.CONVEYANCE

    @staticmethod
    def supports(context: DriveContext) -> bool:
        return context.traits.drive_type in (DriveType.HDD, DriveType.SSD)
