import DriveChip from "../DriveChip"
import LineKey from "./LineKey"
import type { ChartDrive } from "./historySeries"

/** A charted drive named the way every chart names it in dense places —
 *  tooltip rows, job lines, callouts: a thin chip led by the drive's line key,
 *  serial shortened to its last four characters. */
export default function ChartDriveChip({ drive }: { drive: ChartDrive }) {
  return <DriveChip drive={drive.drive} serial="tail" thin lead={<LineKey {...drive.style} />} />
}
