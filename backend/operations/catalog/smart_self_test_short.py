"""
operations.catalog.smart_self_test_short — SMART short self-test (~2 minutes).

A quick electrical/mechanical check plus a partial read scan. Good as a
first pass before committing to the much longer extended test.
"""

from drives.tools.smartctl import SelfTestType
from operations.catalog.smart_self_test_base import SmartSelfTestOperation


class SmartSelfTestShortOperation(SmartSelfTestOperation):
    name = "SMART Self-Test (Short)"
    test_type = SelfTestType.SHORT
