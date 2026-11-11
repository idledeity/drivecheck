import type { Job, JobSmartSnapshot, JobStatus, SmartChange } from "./types"
import { formatDuration, formatTimestamp, humanizeKey, jobResultText } from "./format"
import "./JobDetails.css"

// Every job shows the same common properties (status, result, times, device)
// whatever its operation; its settings and operation-specific result fields
// follow in their own sections. JobDetails is the full two-column view
// (QueueTab/HistoryTab expanded rows); JobDetailRows is the single-column
// summary for narrow spots (DriveCard's task popover).

const STATUS_LABEL: Record<JobStatus, string> = {
  queued:      "Queued",
  running:     "Running",
  completed:   "Completed",
  failed:      "Failed",
  cancelled:   "Cancelled",
  interrupted: "Interrupted",
}

function seconds(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000
}

// A queue wait shorter than this isn't worth a row of its own.
const QUEUE_WAIT_SHOWN_SECONDS = 5

function formatSettingValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") return value.toLocaleString()
  return String(value)
}

function formatResultValue(key: string, value: unknown): string {
  if (typeof value === "number" && key.includes("bytes")) return `${value.toLocaleString()} bytes`
  return formatSettingValue(value)
}

function JobSummaryRows({ job }: { job: Job }) {
  const device = typeof job.result?.device === "string" ? job.result.device : null
  const queuedFor = job.started_at ? seconds(job.created_at, job.started_at) : null
  return (
    <>
      <DetailRow label="Status" value={STATUS_LABEL[job.status]} valueClassName={`job-status-${job.status}`} />
      <DetailRow label="Result" value={jobResultText(job)} />
      {job.started_at
        ? <DetailRow label="Started" value={formatTimestamp(job.started_at)} />
        : <DetailRow label="Queued at" value={formatTimestamp(job.created_at)} />}
      {job.finished_at && <DetailRow label="Finished" value={formatTimestamp(job.finished_at)} />}
      {job.started_at && job.finished_at && (
        <DetailRow label="Duration" value={formatDuration(seconds(job.started_at, job.finished_at))} />
      )}
      {queuedFor !== null && queuedFor >= QUEUE_WAIT_SHOWN_SECONDS && (
        <DetailRow label="Waited" value={`${formatDuration(queuedFor)} in queue`} />
      )}
      {device && <DetailRow label="Device" value={device} />}
    </>
  )
}

function JobSettingsRows({ job }: { job: Job }) {
  if (job.settings.length === 0) return <p className="job-detail-empty">No settings</p>
  return (
    <>
      {job.settings.map(s => (
        <DetailRow key={s.name} label={s.label ?? humanizeKey(s.name)} value={formatSettingValue(s.value)} />
      ))}
    </>
  )
}

function JobResultRows({ job }: { job: Job }) {
  // Device is a common property above. A self-test's "result" string is what
  // its summary shows as Result — but only when there is a summary; without
  // one (operation since removed, or no summarize) this is its only showing.
  const shownAbove = job.summary != null ? ["device", "result"] : ["device"]
  const entries = Object.entries(job.result ?? {}).filter(([key]) => !shownAbove.includes(key))
  if (entries.length === 0) return null
  return (
    <section className="job-detail-section">
      <h4 className="job-detail-heading">Details</h4>
      {entries.map(([key, value]) => (
        <DetailRow key={key} label={humanizeKey(key)} value={formatResultValue(key, value)} />
      ))}
    </section>
  )
}

// Single-column summary: common properties + settings.
export function JobDetailRows({ job }: { job: Job }) {
  return (
    <>
      <JobSummaryRows job={job} />
      {job.settings.length > 0 && (
        <>
          <h4 className="job-detail-heading">Settings</h4>
          <JobSettingsRows job={job} />
        </>
      )}
    </>
  )
}

// Full view: common properties, settings and details on the left; the SMART
// before/after comparison on the right.
export function JobDetails({ job }: { job: Job }) {
  return (
    <div className="job-details">
      <div className="job-details-col">
        <section className="job-detail-section">
          <JobSummaryRows job={job} />
        </section>
        <section className="job-detail-section">
          <h4 className="job-detail-heading">Settings</h4>
          <JobSettingsRows job={job} />
        </section>
        <JobResultRows job={job} />
      </div>
      <div className="job-details-col">
        <JobSmartPanel job={job} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SMART before/after
// ---------------------------------------------------------------------------

// Rows in reading order: the verdict and error counters first, wear after.
const SMART_ROWS: {
  key: string
  label: string
  format: (v: number | boolean) => string
  bad?: (v: number | boolean) => boolean  // a value that is bad in itself, changed or not
}[] = [
  { key: "smart_passed",       label: "SMART status",        format: v => (v ? "Passed" : "Failed"), bad: v => v === false },
  { key: "reallocated",        label: "Reallocated sectors", format: v => v.toLocaleString() },
  { key: "pending",            label: "Pending sectors",     format: v => v.toLocaleString() },
  { key: "uncorrected",        label: "Uncorrected errors",  format: v => v.toLocaleString() },
  { key: "crc_errors",         label: "CRC errors",          format: v => v.toLocaleString() },
  { key: "reallocated_events", label: "Reallocation events", format: v => v.toLocaleString() },
  { key: "power_on_hours",     label: "Power-on hours",      format: v => `${v.toLocaleString()}h` },
  { key: "load_unload_cycles", label: "Load/unload cycles",  format: v => v.toLocaleString() },
  { key: "temp",               label: "Temperature",         format: v => `${v}°C` },
]

function formatChange(change: SmartChange | undefined): string {
  if (!change || change.change === null || change.change === 0) return ""
  return change.change > 0 ? `+${change.change.toLocaleString()}` : change.change.toLocaleString()
}

function SnapshotNote({ label, snapshot, pending }: { label: string; snapshot: JobSmartSnapshot | null; pending: string }) {
  if (!snapshot) return <div className="job-smart-note">{label}: {pending}</div>
  if (snapshot.error) {
    return <div className="job-smart-note job-smart-note-error">{label}: capture failed — {snapshot.error}</div>
  }
  return (
    <div className="job-smart-note">
      {label}: {formatTimestamp(snapshot.captured_at)}{snapshot.reused ? " (reused a recent snapshot)" : ""}
    </div>
  )
}

function HealthCell({ snapshot }: { snapshot: JobSmartSnapshot | null }) {
  const health = snapshot?.health
  if (!health || health.health_pct === null) return <td>—</td>
  const tone = health.health_status === "Failing" ? "job-smart-bad" : health.health_status === "Degraded" ? "job-smart-warn" : undefined
  return <td className={tone}>{health.health_pct} · {health.health_status}</td>
}

export function JobSmartPanel({ job }: { job: Job }) {
  const { before, after, comparison } = job.smart
  if (!before && !after) {
    return (
      <section className="job-detail-section">
        <h4 className="job-detail-heading">SMART before → after</h4>
        <p className="job-detail-empty">
          {job.status === "queued" ? "Snapshots are taken when the job starts and ends." : "No SMART snapshots were recorded for this job."}
        </p>
      </section>
    )
  }

  const worsened = new Set(comparison?.worsened ?? [])
  const cell = (side: JobSmartSnapshot | null, row: (typeof SMART_ROWS)[number]) => {
    const v = side?.signals?.[row.key]
    if (v === null || v === undefined) return <td>—</td>
    return <td className={row.bad?.(v) ? "job-smart-bad" : undefined}>{row.format(v)}</td>
  }
  const rows = SMART_ROWS.filter(row => {
    // Skip signals this drive type doesn't report on either side (e.g. pending on SAS).
    const b = before?.signals?.[row.key]
    const a = after?.signals?.[row.key]
    return (b !== null && b !== undefined) || (a !== null && a !== undefined)
  })
  // Label by key, not by filtering SMART_ROWS: a counter the table doesn't
  // list must still be named rather than silently dropped from the verdict.
  const signalLabel = (key: string) => SMART_ROWS.find(r => r.key === key)?.label ?? humanizeKey(key)
  const worsenedLabels = (comparison?.worsened ?? []).map(key => {
    const change = formatChange(comparison?.changes[key])
    return change ? `${signalLabel(key)} ${change}` : signalLabel(key)
  })
  const uncomparedLabels = (comparison?.uncompared ?? []).map(signalLabel)

  return (
    <section className="job-detail-section">
      <h4 className="job-detail-heading">SMART before → after</h4>
      {comparison && worsenedLabels.length > 0 && (
        <div className="job-smart-verdict job-smart-worse">Got worse during this run: {worsenedLabels.join(", ")}</div>
      )}
      {comparison && uncomparedLabels.length > 0 && (
        <div className="job-smart-verdict job-smart-unknown">
          Could not compare (reported in only one snapshot): {uncomparedLabels.join(", ")}
        </div>
      )}
      {comparison && worsenedLabels.length === 0 && uncomparedLabels.length === 0 && (
        <div className="job-smart-verdict job-smart-same">No error counters increased during this run</div>
      )}
      <table className="job-smart-table">
        <thead>
          <tr><th /><th>Before</th><th>After</th><th>Change</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Health score</td>
            <HealthCell snapshot={before} />
            <HealthCell snapshot={after} />
            <td />
          </tr>
          {rows.map(row => (
            <tr key={row.key} className={worsened.has(row.key) ? "job-smart-row-worse" : undefined}>
              <td>{row.label}</td>
              {cell(before, row)}
              {cell(after, row)}
              <td>{formatChange(comparison?.changes[row.key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <SnapshotNote label="Before" snapshot={before} pending="not taken" />
      <SnapshotNote label="After" snapshot={after} pending={job.status === "running" ? "taken when the job ends" : "not taken"} />
      {(before?.snapshot_id !== undefined || after?.snapshot_id !== undefined) && (
        <a className="job-smart-link" href={`/api/jobs/${job.id}/smart`} target="_blank" rel="noreferrer"
           onClick={e => e.stopPropagation()}>
          Full SMART reports (JSON)
        </a>
      )}
    </section>
  )
}

export function DetailRow({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="job-detail-row">
      <span className="job-detail-label">{label}</span>
      <span className={`job-detail-value${valueClassName ? ` ${valueClassName}` : ""}`}>{value}</span>
    </div>
  )
}
