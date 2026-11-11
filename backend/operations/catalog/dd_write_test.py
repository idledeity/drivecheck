"""
operations.catalog.dd_write_test — sequential full-disk write test using dd.

Writes zeros from /dev/zero to the target device with `dd if=/dev/zero
of=<device>`, measuring write throughput across the drive surface. Process
handling, restart reattachment and the log-based verdict live in DDOperation
(operations.catalog.dd_common) and LoggedProcessOperation
(operations.logged_process).

THIS OPERATION DESTROYS ALL DATA ON THE TARGET DEVICE. It refuses to run if any
partition of the device is currently mounted, checked via /proc/mounts at startup.
"""

from drives.drive_models import DriveContext
from operations.catalog.dd_common import DDOperation
from operations.operation import ParamSpec


class DDWriteTestOperation(DDOperation):
    name = "Write Test (dd)"
    destructive = True
    result_key = "bytes_written"
    verb = "written"
    summary_verb = "Wrote"
    params = [
        ParamSpec(name="block_size",   label="Block size (bytes)",        type="number",  default=1048576, min=4096, max=16777216),
        ParamSpec(name="count",        label="Block count (0 = all)",     type="number",  default=0, min=0),
        ParamSpec(name="skip",         label="Skip blocks from start",    type="number",  default=0, min=0),
        ParamSpec(name="conv_fsync",   label="Sync to disk when done",    type="boolean", default=True),
        ParamSpec(name="oflag_direct", label="Direct I/O (bypass cache)", type="boolean", default=False),
    ]

    def _build_command(self, context: DriveContext, params: dict) -> list[str]:
        device = context.block_device_path
        if self._total_bytes is None:
            raise RuntimeError(
                f"capacity of {device} is unknown — set an explicit block count for the write test"
            )

        # Stop on the exact last byte (count in bytes via iflag=count_bytes) rather
        # than running into the end of the device: hitting the end makes dd exit 1
        # with "No space left on device" and skip conv=fsync.
        cmd = [
            "dd", "if=/dev/zero", f"of={device}", f"bs={self._block_size}",
            f"count={self._total_bytes}", "iflag=count_bytes", "status=progress",
        ]
        skip = int(params["skip"])
        if skip > 0:
            cmd.append(f"seek={skip}")
        if params["conv_fsync"]:
            cmd.append("conv=fsync")
        if params["oflag_direct"]:
            cmd.append("oflag=direct")
        return cmd
