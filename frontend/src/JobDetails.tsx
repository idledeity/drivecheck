import type { Job, JobSmartSnapshot, JobStatus, SmartChange } from "./types"
import { formatDuration, formatTimestamp, humanizeKey, jobResultText } from "./format"
import { healthSeverity, severityClass, signalName } from "./signals"
import SignalValue from "./SignalValue"
import "./JobDetails.css"

// Every job shows the same common properties (status, result, times, device)
// whatever its operation; its settings and operation-specific result fields
// follow in their own sections. JobDetails is the full two-column view
// (JobRow expanded rows); JobDetailRows is the single-column
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
  // Significant digits, not the default 3 fraction digits: 0.0004 must not show as 0.
  if (typeof value === "number") return value.toLocaleString(undefined, { maximumSignificantDigits: 15 })
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
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
      <DetailRow label="Category" value={job.category} />
      <DetailRow label="Created" value={formatTimestamp(job.created_at)} />
      {job.started_at && <DetailRow label="Started" value={formatTimestamp(job.started_at)} />}
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

// The operation-specific result fields not already shown as common properties.
function resultEntries(job: Job): [string, unknown][] {
  // Device is a common property above. A self-test's "result" string is what
  // its summary shows as Result — but only when there is a summary; without
  // one (operation since removed, or no summarize) this is its only showing.
  const shownAbove = job.summary != null ? ["device", "result"] : ["device"]
  return Object.entries(job.result ?? {}).filter(([key]) => !shownAbove.includes(key))
}

function JobResultRows({ job }: { job: Job }) {
  return (
    <>
      {resultEntries(job).map(([key, value]) => (
        <DetailRow key={key} label={humanizeKey(key)} value={formatResultValue(key, value)} />
      ))}
    </>
  )
}

// Single-column summary: common properties, settings and result details.
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
      {resultEntries(job).length > 0 && (
        <>
          <h4 className="job-detail-heading">Details</h4>
          <JobResultRows job={job} />
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
        {resultEntries(job).length > 0 && (
          <section className="job-detail-section">
            <h4 className="job-detail-heading">Details</h4>
            <JobResultRows job={job} />
          </section>
        )}
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
// Labels, formats and severity colours come from the shared signal registry.
const SMART_ROWS = [
  "smart_passed", "reallocated", "pending", "uncorrected", "crc_errors",
  "reallocated_events", "power_on_hours", "load_unload_cycles", "temp",
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
  const severity = healthSeverity(health.health_status)
  return <td><span className={`sig-value ${severityClass(severity)}`}>{health.health_pct} · {health.health_status}</span></td>
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
  const cell = (side: JobSmartSnapshot | null, key: string) => (
    <td><SignalValue signal={key} value={side?.signals?.[key]} flag={side?.signal_flags?.[key]} /></td>
  )
  const rows = SMART_ROWS.filter(key => {
    // Skip signals this drive type doesn't report on either side (e.g. pending on SAS).
    const b = before?.signals?.[key]
    const a = after?.signals?.[key]
    return (b !== null && b !== undefined) || (a !== null && a !== undefined)
  })
  // Name by key (signalName humanizes unknown keys): a counter the table
  // doesn't list must still be named rather than silently dropped from the verdict.
  const worsenedLabels = (comparison?.worsened ?? []).map(key => {
    const change = formatChange(comparison?.changes[key])
    return change ? `${signalName(key)} ${change}` : signalName(key)
  })
  const uncomparedLabels = (comparison?.uncompared ?? []).map(signalName)

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
          {rows.map(key => (
            <tr key={key} className={worsened.has(key) ? "job-smart-row-worse" : undefined}>
              <td>{signalName(key)}</td>
              {cell(before, key)}
              {cell(after, key)}
              <td>{formatChange(comparison?.changes[key])}</td>
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
