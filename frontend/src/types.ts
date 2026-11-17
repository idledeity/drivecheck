export type Settings = {
  footer_signals: Record<string, string[]>
  // Local ISO time the user last marked finished jobs as seen; jobs that
  // finished after it count as new results. Absent until first set.
  jobs_seen_at?: string | null
}

export type ConfigPropType = "int" | "float" | "str" | "bool" | "enum" | "list" | "module_list"

export type ConfigProp = {
  key: string
  label: string
  section: string
  description: string
  tooltip: string | null
  type: ConfigPropType
  value: unknown
  default: unknown
  min: number | null
  max: number | null
  choices: string[] | null
  restart_required: boolean
  file_only: boolean
  /** What null means for this prop (e.g. "No limit"); null when null isn't a choice. */
  none_label: string | null
}

export type ProbeWarning = {
  path: string
  reason: string
}

export type LogRecord = {
  timestamp: string
  level: string
  logger: string
  message: string
}

export type SmartAttributeRow = {
  key: string
  label: string
  value: string
  status: "ok" | "warn" | "crit"
  detail: string | null
}

export type RawSnapshot = {
  captured_at: string
  probe: string
  raw: {
    smartctl?: Record<string, unknown>
    smart_attributes?: SmartAttributeRow[]
    self_test_log?: SmartAttributeRow[]
  }
}

export type SmartStatus = "ok" | "warn" | "crit"

/** A named field on the SMART page (backend analysis.smart_detail). */
export type SmartField = {
  key: string
  label: string
  value: number | string | boolean | null
  /** How value is formatted; null for text. */
  unit: "hours" | "minutes" | "seconds" | "ms" | "count" | "celsius" | "bytes" | "percent" | null
  status: SmartStatus
  /** Where in the smartctl output it came from, e.g. "ATA 193" or "scsi_grown_defect_list". */
  source: string | null
  detail: string | null
  limit: { value: number; kind: "rated" | "trip" | "threshold" } | null
  /** The ATA attribute it comes from, for its normalized / worst / threshold columns. */
  attribute_id: number | null
}

export type SmartAttribute = {
  id: number
  name: string
  value: number | null
  worst: number | null
  thresh: number | null
  margin: number | null
  type: "Pre-fail" | "Old-age"
  updated: "Always" | "Offline"
  flags: string | null
  raw_value: number | null
  raw_string: string | null
  when_failed: string | null
  status: SmartStatus
}

export type SmartLeaf = { path: string; value: number | string | boolean | null }

export type SmartDetail = {
  protocol: string | null
  groups: { key: string; label: string; fields: SmartField[] }[]
  attributes?: SmartAttribute[]
  scsi_error_counters?: {
    columns: { key: string; label: string }[]
    rows: ({ direction: string } & Record<string, number | null | string>)[]
  }
  nvme_health_log?: SmartLeaf[]
  other_fields: SmartLeaf[]
}

/** A drive's latest full SMART read (/smart/detail): the Report and SMART pages, as one point in time. */
export type SmartDetailResponse = {
  captured_at: string
  probe: string
  /** The read's own signals, flags and health score; null for a read stored without signals. */
  signals: SmartSignals | null
  signal_flags: Record<string, "ok" | "warn" | "crit"> | null
  health: { health_pct: number | null; health_status: Drive["health_status"] } | null
  detail: SmartDetail | null
  self_test_log: SmartAttributeRow[]
}

export type DriveIOActivity = {
  read_iops: number | null
  write_iops: number | null
  read_bytes_per_sec: number | null
  write_bytes_per_sec: number | null
  busy_pct: number | null
}

export type DriveVitals = {
  temp: number | null
  temp_source: "hwmon" | "smartctl" | null
  captured_at: string | null
  io: DriveIOActivity
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted"

export type OperationProgress = {
  percent: number | null
  message: string | null
  eta_seconds: number | null
}

// One job setting (param), labelled like the Run Task form. label is null if
// the operation or param is no longer known — fall back to the raw name.
export type JobSetting = {
  name: string
  label: string | null
  value: unknown
}

export type SmartSignals = Record<string, number | boolean | null>

// One side (before/after) of a job's condensed SMART snapshot. snapshot_id
// points at the full report (GET /api/jobs/<id>/smart). A failed capture has
// only captured_at + error.
export type JobSmartSnapshot = {
  snapshot_id?: number
  captured_at: string
  signals?: SmartSignals
  signal_flags?: Record<string, "ok" | "warn" | "crit">  // same thresholds as Drive.signal_flags
  health?: { health_pct: number | null; health_status: string | null }
  reused?: boolean
  error?: string
}

export type SmartChange = {
  before: number | boolean | null
  after: number | boolean | null
  change: number | null
}

export type JobSmart = {
  before: JobSmartSnapshot | null
  after: JobSmartSnapshot | null
  // uncompared: error counters reported in only one snapshot, so not known to be unchanged
  comparison: { changes: Record<string, SmartChange>; worsened: string[]; uncompared: string[] } | null
}

export type Job = {
  id: string
  drive_guid: string
  operation: string
  operation_name: string
  category: string
  params: Record<string, unknown>
  status: JobStatus
  progress: OperationProgress
  result: Record<string, unknown> | null
  summary: string | null        // operation's one-line outcome, completed jobs only
  settings: JobSetting[]
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  smart: JobSmart
  logs: JobLogs
  queue_position: number | null  // run order while queued (0 starts first), else null
}

// The job's output (GET /api/jobs/<id>/logs/<kind>), null when it has none:
// "raw" is the program's own output (a running job's is still growing),
// "summary" its important lines, only for operations that summarize — small,
// so its text comes along for showing inline.
export type JobLogFile = { size: number }
export type JobSummaryLog = JobLogFile & { text: string }
export type JobLogs = { raw: JobLogFile | null; summary: JobSummaryLog | null }

export type ParamSpec = {
  name: string
  label: string
  type: "number" | "string" | "boolean"
  default: unknown
  min: number | null
  max: number | null
  tooltip?: string | null
}

export type OperationInfo = {
  key: string
  name: string
  category: string
  tool: string
  destructive: boolean
  params: ParamSpec[]
}

export type Drive = {
  guid: string
  device: string
  info_name: string
  block_device: string | null
  serial: string | null
  manufacturer: string | null
  manufacturer_short: string | null
  white_label: string | null
  model: string | null
  capacity_bytes: number | null
  drive_type: "HDD" | "SSD" | "NVMe" | "SAS" | "Unknown" | null
  form_factor: string | null
  rpm: number | null
  bus: string | null
  power_on_hours: number | null
  temp: number | null
  reallocated: number | null
  pending: number | null
  load_unload_cycles: number | null
  uncorrected: number | null
  crc_errors: number | null
  smart_passed: boolean | null
  health_pct: number | null
  health_status: "Healthy" | "Degraded" | "Failing" | null
  signal_flags: Record<string, "ok" | "warn" | "crit">
  /** The latest SMART read of either kind (attribute or full): health and the signals above. */
  last_polled_at: string | null
  /** The latest full SMART read (attributes table, self-test log). */
  last_full_read_at: string | null
  /** Seconds a reading may age before it shows as overdue (see AsOf). */
  stale_after_s: { vitals: number; smart: number }
  is_mounted: boolean
  vitals: DriveVitals
  label: string | null
  locked: boolean
  first_seen: string | null
}

export type SortKey =
  | "label" | "manufacturer" | "model" | "capacity"
  | "health" | "active_task" | "first_seen" | "locked"
  | "device" | "serial"

export interface SortState {
  key: SortKey
  dir: "asc" | "desc"
}
