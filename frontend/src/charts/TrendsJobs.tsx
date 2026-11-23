import { useContext, useState } from "react"
import { IconChevronRight } from "@tabler/icons-react"
import { canHover } from "../useHoverPopover"
import { useStoredFlag } from "../useStoredFlag"
import { ChartHoverContext, ChartLatestContext } from "./chartHover"
import ChartDriveChip from "./ChartDriveChip"
import JobsDuring from "./JobsDuring"
import { bucketLabel, jobsDuring } from "./historySeries"
import type { ChartDrive, JobDuring } from "./historySeries"
import { clockLabel } from "./scales"
import type { DriveHistoryData } from "./useDriveHistory"

// Whether the desktop list is folded open, remembered in this browser.
const OPEN_KEY = "trends.jobsOpen"

/** The jobs running at the charts' time, listed once for the whole Trends
 *  page instead of under every chart: the charts' readings are synced, so
 *  each would list the same jobs. Reads at the same time as the readings —
 *  the hovered or pinned one, else the group's newest.
 *
 *  On a desktop the list folds open in place (remembered in this browser),
 *  at a fixed height, so moving along a chart never resizes the filter row
 *  and shifts the charts under the pointer. On touch it's one line, with
 *  several jobs behind a popover (JobsDuring, compact). */
export default function TrendsJobs({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const hover = useContext(ChartHoverContext)?.hover ?? null
  const latest = useContext(ChartLatestContext)?.latest ?? null
  const [desktop] = useState(canHover)
  const [open, setOpen] = useStoredFlag(OPEN_KEY, false)

  const t = hover?.t ?? latest
  if (t === null || t < data.start) return null
  // Grouped by drive, in legend order, then by start.
  const order = new Map(drives.map((d, i) => [d.guid, i]))
  const jobs = jobsDuring(data, drives, t)
    .toSorted((a, b) => order.get(a.drive.guid)! - order.get(b.drive.guid)! || a.start - b.start)
  const when = <span className="trends-jobs-time">{bucketLabel(t, data.bucketMs)}</span>

  if (!desktop) {
    return (
      <div className="trends-jobs-strip">
        {when}
        <JobsDuring jobs={jobs} compact />
      </div>
    )
  }

  return (
    <div className={`trends-jobs-strip desktop${open ? " open" : ""}`}>
      <div className="trends-jobs-head">
        <button type="button" className="trends-jobs-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <IconChevronRight size={13} className="trends-jobs-chevron" aria-hidden />
          {jobs.length === 0 ? "No jobs" : jobs.length === 1 ? "1 job" : `${jobs.length} jobs`}
        </button>
        {when}
        {/* Folded, the one job still shows: nothing to open for. */}
        {!open && jobs.length === 1 && <JobLine job={jobs[0]} />}
      </div>
      {open && (
        <div className="trends-jobs-list" role="list" aria-label="Jobs running at this time">
          {jobs.length === 0
            ? <div className="jobs-during-none">No jobs running at this time</div>
            : jobs.map(j => <div key={j.id} role="listitem"><JobLine job={j} /></div>)}
        </div>
      )}
    </div>
  )
}

/** A job: name, its drive's chip, when it ran, and how it ended if not well. */
function JobLine({ job }: { job: JobDuring }) {
  return (
    <span className="jobs-during-row">
      <span className="jobs-during-name">{job.name}</span>
      <ChartDriveChip drive={job.drive} short />
      <span className="trends-jobs-when">
        {clockLabel(job.start)}–{job.end === null ? "now" : clockLabel(job.end)}
        {job.status !== "completed" && job.end !== null && <span className={`trends-jobs-status ${job.status}`}> · {job.status}</span>}
      </span>
    </span>
  )
}
