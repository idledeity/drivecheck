"""Each operation's one-line result summary (OperationBase.summarize).

Summaries are built from stored result dicts — including those of past jobs —
so they must work on the class, without an instance.
"""

import pytest

from operations.catalog.badblocks_write_test import BadblocksWriteTestOperation
from operations.catalog.dd_read_test import DDReadTestOperation
from operations.catalog.dd_write_test import DDWriteTestOperation
from operations.catalog.debug.debug_sleep import DebugSleepOperation
from operations.catalog.nvme_self_test_short import NvmeSelfTestShortOperation
from operations.catalog.secure_erase import SecureEraseOperation
from operations.catalog.smart_self_test_short import SmartSelfTestShortOperation
from operations.operation import OperationBase, format_bytes


@pytest.mark.parametrize("op_cls,result,summary", [
    (DDReadTestOperation, {"bytes_read": 6_001_175_126_016, "device": "/dev/sdb", "block_size": 1048576},
     "Read 6.0 TB with no errors"),
    (DDWriteTestOperation, {"bytes_written": 7_340_032, "device": "/dev/sdb", "block_size": 1048576},
     "Wrote 7.3 MB with no errors"),
    (BadblocksWriteTestOperation, {"device": "/dev/sdb", "bad_blocks": 0, "passes": 1}, "No bad blocks found in 1 pass"),
    (BadblocksWriteTestOperation, {"device": "/dev/sdb", "bad_blocks": 0, "passes": 2}, "No bad blocks found in 2 passes"),
    (SecureEraseOperation, {"device": "/dev/sdb", "total_passes": 2}, "Erased in 2 passes"),
    # Real result strings: SAS words it "Completed", ATA "completed without error".
    (SmartSelfTestShortOperation, {"device": "/dev/sdb", "test_type": "short", "result": "Completed"},
     "Self-test: Completed"),
    (SmartSelfTestShortOperation, {"device": "/dev/sde", "test_type": "short", "result": "completed without error"},
     "Self-test: Completed without error"),
    (NvmeSelfTestShortOperation, {"device": "/dev/nvme0", "test_type": "short", "result": "Completed without error"},
     "Self-test: Completed without error"),
    (DebugSleepOperation, {"slept_seconds": 40.0}, "Slept 40s"),
])
def test_summaries(op_cls, result, summary):
    assert op_cls.summarize(result) == summary


def test_operations_without_a_summary_return_none():
    assert OperationBase.summarize({"anything": 1}) is None


def test_format_bytes_uses_decimal_units_like_drive_vendors():
    assert format_bytes(14_000_519_643_136) == "14.0 TB"
    assert format_bytes(3_000_592_982_016) == "3.0 TB"
    assert format_bytes(512) == "512 B"


def test_format_bytes_picks_the_unit_after_rounding():
    assert format_bytes(999_999_999_999) == "1.0 TB"
    assert format_bytes(999_999) == "1.0 MB"
    assert format_bytes(999_949) == "999.9 KB"
    assert format_bytes(999) == "999 B"
    assert format_bytes(1000) == "1.0 KB"
