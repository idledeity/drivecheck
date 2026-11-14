import ChartDriveChip from "./ChartDriveChip"
import type { ChartDrive } from "./historySeries"

/** The tooltip's "jobs running in this bucket" lines: each job's name and its
 *  drive's chip (led by the drive's line key, as in the legend). */
export default function JobsDuring({ jobs }: { jobs: { id: string; name: string; drive: ChartDrive }[] }) {
  return (
    <div className="jobs-during">
      {jobs.map(j => (
        <div key={j.id} className="jobs-during-row">
          <span className="jobs-during-name">{j.name}</span>
          <ChartDriveChip drive={j.drive} />
        </div>
      ))}
    </div>
  )
}
