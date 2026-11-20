import { useState } from "react"
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { formatClock, formatDuration, formatRelativeTime, jobResultText } from "./format"
import { JobDetails } from "./JobDetails"
import { useEdgeFade } from "./useEdgeFade"
import { useJobTiming } from "./useJobTiming"
import DriveChip from "./DriveChip"
import CancelJobButton from "./CancelJobButton"
import { STATUS_ICON } from "./jobStatusIcon"
import "./JobRow.css"


// A queued task's place under Up next and its move buttons (null: can't move
// that way). `note` explains a wait the order doesn't.
export type QueueSlot = {
  n: number
  up: (() => void) | null
  down: (() => void) | null
  label: string
  title?: string
  note?: React.ReactNode
}

// One job: status icon, drive chip, operation, then progress while running,
// the outcome once finished, and its details when clicked. Used by History and
// by Activity's lanes and summary. `compact` leaves out the drive chip and
// puts the outcome on its own line, for a narrow popover on that drive's card.
// `step` is a batch's step, drawn as a line inside its batch's row (no box,
// no drive chip). `queue` adds its place under Up next and move buttons.
export function JobRow({ job, drive, onCancel, compact = false, step = false, queue }: {
  job: Job; drive: Drive | undefined; onCancel: (jobId: string) => void; compact?: boolean; step?: boolean; queue?: QueueSlot
}) {
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
    <div className={`queue-row queue-row-${job.status}${compact ? " compact" : ""}${step ? " step" : ""}`} onClick={() => setExpanded(e => !e)}>
      <div className="queue-row-main">
        <span className="queue-lead">
          {queue && <span className="queue-n">{queue.n}</span>}
          <span className={`queue-status-icon queue-status-${job.status}`}>{STATUS_ICON[job.status]}</span>
        </span>
        {compact || step ? null : drive
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
        {queue?.note && <span className="queue-note">{queue.note}</span>}
        <div className="queue-right">
          {job.status === "queued" && !step && <span className="queue-time">queued {formatClock(job.created_at)}</span>}
          {queue && <QueueMoveButtons queue={queue} />}
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

export function QueueMoveButtons({ queue }: { queue: QueueSlot }) {
  const click = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  return (
    <span className="queue-move">
      <button className="icon-btn" title={queue.title ?? "Move up"} aria-label={`Move up: ${queue.label}`} disabled={!queue.up} onClick={queue.up ? click(queue.up) : undefined}>
        <IconChevronUp size={14} />
      </button>
      <button className="icon-btn" title={queue.title ?? "Move down"} aria-label={`Move down: ${queue.label}`} disabled={!queue.down} onClick={queue.down ? click(queue.down) : undefined}>
        <IconChevronDown size={14} />
      </button>
    </span>
  )
}
