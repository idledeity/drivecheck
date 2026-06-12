export type Settings = {
  footer_signals: Record<string, string[]>
}

export type CollectorStatus = {
  polling: boolean
  last_polled_at: string | null
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
  vitals: DriveVitals
  label: string | null
}
