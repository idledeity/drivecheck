import { IconAlertTriangle, IconBan, IconBarcode, IconCheck, IconClock, IconLoader2, IconX } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { driveTitle, formatRelativeTime } from "./format"
import { StubTab } from "./WorkspacePanel"
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

function JobRow({ job, drive, onCancel }: { job: Job; drive: Drive | undefined; onCancel: (jobId: string) => void }) {
  const cancellable = job.status === "running" || job.status === "queued"
  return (
    <div className={`queue-row queue-row-${job.status}`}>
      <div className="queue-row-main">
        <span className={`queue-status-icon queue-status-${job.status}`}>{STATUS_ICON[job.status]}</span>
        <span className="queue-drive-group">
          <span className="queue-drive">{drive ? driveTitle(drive) : job.drive_guid}</span>
          {drive?.label && <span className="queue-label">({drive.label})</span>}
        </span>
        {drive?.serial && (
          <span className="queue-serial"><IconBarcode size={13} />{drive.serial}</span>
        )}
        <span className="queue-op">{job.operation_name}</span>
        <div className="queue-right">
          {job.finished_at && <span className="queue-time">{formatRelativeTime(job.finished_at)}</span>}
          {cancellable && (
            <button className="queue-cancel" onClick={() => onCancel(job.id)} title="Cancel">
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
          {job.progress.message && <span className="queue-msg">{job.progress.message}</span>}
        </div>
      )}
      {job.status === "failed" && job.error && <div className="queue-error">{job.error}</div>}
    </div>
  )
}
