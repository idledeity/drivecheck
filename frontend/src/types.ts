export type Settings = {
  footer_signals: Record<string, string[]>
}

export type ConfigPropType = "int" | "float" | "str" | "bool" | "enum"

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

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type OperationProgress = {
  percent: number | null
  message: string | null
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
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export type ParamSpec = {
  name: string
  label: string
  type: "number" | "string" | "boolean"
  default: unknown
  min: number | null
  max: number | null
}

export type OperationInfo = {
  key: string
  name: string
  category: string
  tool: string
  params: ParamSpec[]
}

export type Drive = {
  guid: string
  device: string
  info_name: string
  serial: string | null
  manufacturer: string | null
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
  smart_passed: boolean | null
  health_status: "Healthy" | "Degraded" | "Failing" | null
  signal_flags: Record<string, "ok" | "warn" | "crit">
  last_polled_at: string | null
  is_mounted: boolean
  vitals: DriveVitals
  label: string | null
}
