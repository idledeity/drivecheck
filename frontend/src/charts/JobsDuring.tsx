import { useState } from "react"
import { createPortal } from "react-dom"
import { useHoverPopover } from "../useHoverPopover"
import ChartDriveChip from "./ChartDriveChip"
import type { ChartDrive } from "./historySeries"

type Job = { id: string; name: string; drive: ChartDrive }

const HOVER_DELAY_MS = 400   // as the drive card's popovers

/** The tooltip's "jobs running in this bucket" lines: each job's name and its
 *  drive's chip (led by the drive's line key, as in the legend).
 *
 *  Compact (the readings under a narrow chart): always exactly one line, so
 *  scrubbing never changes the readings' height and moves the page under
 *  the finger. "No jobs", the one job, or "N jobs" opening the list in a
 *  popover (hover, or tap on touch). */
export default function JobsDuring({ jobs, compact = false }: { jobs: Job[]; compact?: boolean }) {
  if (!compact) return jobs.length ? <JobList jobs={jobs} /> : null
  if (jobs.length === 0) return <div className="jobs-during-none">No jobs</div>
  if (jobs.length === 1) return <div className="jobs-during"><JobRow job={jobs[0]} /></div>
  return <JobsSummary jobs={jobs} />
}

function JobList({ jobs }: { jobs: Job[] }) {
  return <div className="jobs-during">{jobs.map(j => <JobRow key={j.id} job={j} />)}</div>
}

function JobRow({ job }: { job: Job }) {
  return (
    <div className="jobs-during-row">
      <span className="jobs-during-name">{job.name}</span>
      <ChartDriveChip drive={job.drive} />
    </div>
  )
}

function JobsSummary({ jobs }: { jobs: Job[] }) {
  const [supportsHover] = useState(() => window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false)
  const pop = useHoverPopover<"jobs">({ supportsHover, delayMs: HOVER_DELAY_MS })
  return (
    <>
      <button type="button" className="jobs-during-summary" {...pop.trigger("jobs")}>
        {jobs.length} jobs <span aria-hidden>›</span>
      </button>
      {/* The drive card's popover look; through a portal, so the readings'
          box doesn't clip it (and it can open from inside another popover). */}
      {pop.open && createPortal(
        <div className="dc-popover dc-popover-wide" style={pop.pos} {...pop.popoverProps}>
          <JobList jobs={jobs} />
        </div>,
        document.body,
      )}
    </>
  )
}
