export type Settings = {
  footer_signals: Record<string, string[]>
}

export type CollectorStatus = {
  polling: boolean
  last_polled_at: string | null
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
}
