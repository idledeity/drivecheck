export type Settings = {
  footer_signals: Record<string, string[]>
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
}

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
  last_polled_at: string | null
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
