import { useEffect, useState } from "react"
import { IconAlertTriangle, IconBan, IconCheck, IconClock, IconLoader2, IconX } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { driveTitle, formatDuration, formatRelativeTime } from "./format"
import { JobDetailRows } from "./JobDetails"
import { useEdgeFade } from "./useEdgeFade"
import { StubTab } from "./WorkspacePanel"
import Serial from "./Serial"
import "./QueueTab.css"

interface Props {
  drives: Drive[]
  jobs: Job[]
  onCancel: (jobId: string) => void
}

export default function QueueTab({ drives, jobs, onCancel }: Props) {
  if (jobs.length === 0) {
    return <StubTab label="Queue" note="Running and queued jobs across all drives." />
  }

  const running = jobs.filter(j => j.status === "running")
  const queued = jobs.filter(j => j.status === "queued")
  const finished = jobs
    .filter(j => j.status === "completed" || j.status === "failed" || j.status === "cancelled")
    .sort((a, b) => new Date(b.finished_at ?? b.created_at).getTime() - new Date(a.finished_at ?? a.created_at).getTime())
    .slice(0, 15)

  return (
    <div className="queue-tab">
      <Section title="Running" jobs={running} drives={drives} onCancel={onCancel} />
      <Section title="Queued" jobs={queued} drives={drives} onCancel={onCancel} />
      <Section title="Recently finished" jobs={finished} drives={drives} onCancel={onCancel} />
    </div>
  )
}

function Section({ title, jobs, drives, onCancel }: {
  title: string
  jobs: Job[]
  drives: Drive[]
  onCancel: (jobId: string) => void
}) {
  if (jobs.length === 0) return null
  return (
    <div className="queue-section">
      <div className="queue-section-title">{title}</div>
      {jobs.map(job => (
        <JobRow key={job.id} job={job} drive={drives.find(d => d.guid === job.drive_guid)} onCancel={onCancel} />
      ))}
    </div>
  )
}

const STATUS_ICON: Record<Job["status"], React.ReactNode> = {
  running:   <IconLoader2 size={13} className="spinning" />,
  queued:    <IconClock size={13} />,
  completed: <IconCheck size={13} />,
  failed:    <IconAlertTriangle size={13} />,
  cancelled: <IconBan size={13} />,
}

// Exported for HistoryTab, which renders the same row shape for terminal
// jobs (onCancel is a no-op there since cancellable is never true for them).
export function JobRow({ job, drive, onCancel }: { job: Job; drive: Drive | undefined; onCancel: (jobId: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const cancellable = job.status === "running" || job.status === "queued"

  // Ticks once a second only while this row's job is running — elapsed/ETA
  // text below is derived from this plus job.started_at, not from polled
  // job data (which only changes every few seconds at best).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (job.status !== "running") return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [job.status])

  const elapsedSeconds = job.status === "running" && job.started_at
    ? (now - new Date(job.started_at).getTime()) / 1000
    : null
  // The backend already fills this in (operation's own estimate, or a
  // percent/elapsed extrapolation) — see JobRegistry.get_progress().
  const remainingSeconds = job.progress.eta_seconds ?? null

  // Mobile/touch only (see QueueTab.css) — only fade the message's edge when
  // it's actually scrollable, same as DriveCard's scrollable rows.
  const msgFade = useEdgeFade<HTMLSpanElement>()

  return (
    <div className={`queue-row queue-row-${job.status}`} onClick={() => setExpanded(e => !e)}>
      <div className="queue-row-main">
        <span className={`queue-status-icon queue-status-${job.status}`}>{STATUS_ICON[job.status]}</span>
        <span className="queue-drive-group">
          <span className="queue-drive">{drive ? driveTitle(drive) : job.drive_guid}</span>
          {drive?.label && <span className="queue-label">({drive.label})</span>}
        </span>
        {drive?.serial && <Serial value={drive.serial} className="queue-serial" />}
        <span className="queue-op">{job.operation_name}</span>
        <div className="queue-right">
          {job.finished_at && <span className="queue-time">{formatRelativeTime(job.finished_at)}</span>}
          {cancellable && (
            <button className="queue-cancel" onClick={e => { e.stopPropagation(); onCancel(job.id) }} title="Cancel">
              <IconX size={13} />
            </button>
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
          {(job.progress.message || elapsedSeconds !== null) && (
            <div className="queue-msg-row">
              {job.progress.message && (
                <span ref={msgFade.ref} className={`queue-msg${msgFade.fade ? " queue-edge-fade" : ""}`}>
                  {job.progress.message}
                </span>
              )}
              {elapsedSeconds !== null && (
                <span className="queue-progress-time">
                  {formatDuration(elapsedSeconds)} · {remainingSeconds !== null ? `${formatDuration(remainingSeconds)} left` : "—"}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {job.status === "failed" && job.error && <div className="queue-error">{job.error}</div>}
      {expanded && (
        <div className="queue-details">
          <JobDetailRows job={job} />
        </div>
      )}
    </div>
  )
}
