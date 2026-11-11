"""
operations.catalog.dd_read_test — sequential full-disk read test using dd.

Reads every byte of the target device with `dd ... of=/dev/null`, exercising
the drive without writing to it. Process handling, restart reattachment and the
log-based verdict live in DDOperation (operations.catalog.dd_common) and
LoggedProcessOperation (operations.logged_process).
"""

from drives.drive_models import DriveContext
from operations.catalog.dd_common import DDOperation
from operations.operation import ParamSpec


class DDReadTestOperation(DDOperation):
    name = "Read Test (dd)"
    result_key = "bytes_read"
    verb = "read"
    summary_verb = "Read"
    params = [
        ParamSpec(name="block_size",   label="Block size (bytes)",           type="number",  default=1048576, min=4096, max=16777216),
        ParamSpec(name="count",        label="Block count (0 = all)",        type="number",  default=0, min=0),
        ParamSpec(name="skip",         label="Skip blocks from start",       type="number",  default=0, min=0),
        ParamSpec(name="conv_noerror", label="Continue on errors (noerror)", type="boolean", default=False),
        ParamSpec(name="conv_sync",    label="Pad errors with zeros (sync)", type="boolean", default=False),
        ParamSpec(name="iflag_direct", label="Direct I/O (bypass cache)",    type="boolean", default=False),
    ]

    def _build_command(self, context: DriveContext, params: dict) -> list[str]:
        cmd = ["dd", f"if={context.block_device_path}", "of=/dev/null", f"bs={self._block_size}", "status=progress"]
        count = int(params["count"])
        skip = int(params["skip"])
        if count > 0:
            cmd.append(f"count={count}")
        if skip > 0:
            cmd.append(f"skip={skip}")
        conv_parts = []
        if params["conv_noerror"]:
            conv_parts.append("noerror")
        if params["conv_sync"]:
            conv_parts.append("sync")
        if conv_parts:
            cmd.append(f"conv={','.join(conv_parts)}")
        if params["iflag_direct"]:
            cmd.append("iflag=direct")
        return cmd
