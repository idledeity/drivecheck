import type { Job } from "./types"
import { formatTimestamp, humanizeKey } from "./format"
import "./JobDetails.css"

// Shared "label: value" rows for a single job's full details — used both
// inline (QueueTab's expanded row) and in a popover (DriveCard).
export function JobDetailRows({ job }: { job: Job }) {
  const paramEntries = Object.entries(job.params)
  const resultEntries = Object.entries(job.result ?? {})

  return (
    <>
      <DetailRow label="Category" value={job.category} />
      <DetailRow label="Created" value={formatTimestamp(job.created_at)} />
      {job.started_at && <DetailRow label="Started" value={formatTimestamp(job.started_at)} />}
      {job.finished_at && <DetailRow label="Finished" value={formatTimestamp(job.finished_at)} />}
      {paramEntries.map(([key, value]) => (
        <DetailRow key={key} label={humanizeKey(key)} value={String(value)} />
      ))}
      {resultEntries.map(([key, value]) => (
        <DetailRow key={key} label={humanizeKey(key)} value={String(value)} />
      ))}
    </>
  )
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="job-detail-row">
      <span className="job-detail-label">{label}</span>
      <span className="job-detail-value">{value}</span>
    </div>
  )
}
