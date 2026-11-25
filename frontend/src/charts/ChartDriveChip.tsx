import { memo } from "react"
import DriveChip from "../DriveChip"
import LineKey from "./LineKey"
import type { ChartDrive } from "./historySeries"

/** A charted drive named the way every chart names it in dense places —
 *  tooltip rows, job lines, callouts: a thin chip led by the drive's line key,
 *  serial shortened to its last four characters. Short: the model alone,
 *  as the Trends legend names it. */
function ChartDriveChip({ drive, short = false }: { drive: ChartDrive; short?: boolean }) {
  return <DriveChip drive={drive.drive} serial="tail" thin short={short} lead={<LineKey {...drive.style} />} />
}

// Memoized: readings rows rebuild on every hover step, and their drives don't change.
export default memo(ChartDriveChip)
