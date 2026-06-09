export type Settings = {
  footer_signals: Record<string, string[]>
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
  last_polled_at: string | null
}
