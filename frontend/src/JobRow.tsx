import { useState } from "react"
import { IconAlertTriangle, IconBan, IconCheck, IconClock, IconHelpCircle, IconLoader2 } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { formatDuration, formatRelativeTime, jobResultText } from "./format"
import { JobDetails } from "./JobDetails"
import { useEdgeFade } from "./useEdgeFade"
import { useJobTiming } from "./useJobTiming"
import DriveChip from "./DriveChip"
import CancelJobButton from "./CancelJobButton"
import "./JobRow.css"

const STATUS_ICON: Record<Job["status"], React.ReactNode> = {
  running:     <IconLoader2 size={13} className="spinning" />,
  queued:      <IconClock size={13} />,
  completed:   <IconCheck size={13} />,
  failed:      <IconAlertTriangle size={13} />,
  cancelled:   <IconBan size={13} />,
  interrupted: <IconHelpCircle size={13} />,
}

// One job: status icon, drive chip, operation, then progress while running,
// the outcome once finished, and its details when clicked. Used by History and
// by Activity's lanes and summary. `compact` leaves out the drive chip and
// puts the outcome on its own line, for a narrow popover on that drive's card.
export function JobRow({ job, drive, onCancel, compact = false }: { job: Job; drive: Drive | undefined; onCancel: (jobId: string) => void; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const cancellable = job.status === "running" || job.status === "queued"
  const finished = !cancellable
  const ranFor = finished && job.started_at && job.finished_at
    ? formatDuration((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000)
    : null

  const timing = useJobTiming(job)

  // Mobile/touch only (see JobRow.css) — only fade the message's edge when
  // it's actually scrollable, same as DriveCard's scrollable rows.
  const [msgFadeRef, msgFaded] = useEdgeFade<HTMLSpanElement>()

  return (
    <div className={`queue-row queue-row-${job.status}${compact ? " compact" : ""}`} onClick={() => setExpanded(e => !e)}>
      <div className="queue-row-main">
        <span className={`queue-status-icon queue-status-${job.status}`}>{STATUS_ICON[job.status]}</span>
        {compact ? null : drive
          ? <span className="queue-drive-id"><DriveChip drive={drive} serial="tail" /></span>
          : <span className="queue-drive-id">{job.drive_guid}</span>}
        <span className="queue-op">{job.operation_name}</span>
        {/* What happened, without expanding the row: the summary, or the error
            in red. Inline on wide rows, its own wrapping line on narrow ones. */}
        {finished && (
          <span className={`queue-outcome${job.status === "failed" || job.status === "interrupted" ? " bad" : ""}`} title={jobResultText(job)}>
            {jobResultText(job)}
          </span>
        )}
        <div className="queue-right">
          {job.finished_at && (
            <span className="queue-time" title={ranFor ? `Ran for ${ranFor}` : undefined}>
              {ranFor && <>{ranFor} · </>}{formatRelativeTime(job.finished_at)}
            </span>
          )}
          {cancellable && (
            <CancelJobButton job={job} drive={drive} onCancel={onCancel} />
          )}
        </div>
      </div>
      {job.status === "running" && (
        <div className="queue-progress">
          <div className="queue-progress-bar-row">
            <div className="queue-bar">
              {job.progress.percent === null
                ? <div className="queue-bar-fill indeterminate" />
                : <div className="queue-bar-fill" style={{ width: `${job.progress.percent}%` }} />}
            </div>
            {job.progress.percent !== null && <span className="queue-pct">{job.progress.percent.toFixed(1)}%</span>}
          </div>
          {(job.progress.message || timing.text) && (
            <div className="queue-msg-row">
              {job.progress.message && (
                <span ref={msgFadeRef} className={`queue-msg${msgFaded ? " queue-edge-fade" : ""}`}>
                  {job.progress.message}
                </span>
              )}
              {timing.text && <span className="queue-progress-time">{timing.text}</span>}
            </div>
          )}
        </div>
      )}
      {expanded && (
        <div className="queue-details">
          <JobDetails job={job} />
        </div>
      )}
    </div>
  )
}
