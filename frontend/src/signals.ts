import type { Drive } from "./types"

export type SignalDescriptor = {
  label: string
  format: (v: Drive[keyof Drive]) => string
  warn?: (v: Drive[keyof Drive]) => boolean
  crit?: (v: Drive[keyof Drive]) => boolean
}

export const SIGNALS: Record<string, SignalDescriptor> = {
  power_on_hours: {
    label:  "Power-on",
    format: v => v !== null ? `${(v as number).toLocaleString()}h` : "—",
  },
  reallocated: {
    label:  "Realloc",
    format: v => v !== null ? String(v) : "—",
    warn:   v => (v as number ?? 0) > 0,
  },
  pending: {
    label:  "Pending",
    format: v => v !== null ? String(v) : "—",
    warn:   v => (v as number ?? 0) > 0,
  },
  uncorrected: {
    label:  "Uncorr",
    format: v => v !== null ? String(v) : "—",
    crit:   v => (v as number ?? 0) > 0,
  },
  load_unload_cycles: {
    label:  "Ld/UL",
    format: v => v !== null ? (v as number).toLocaleString() : "—",
  },
  temp: {
    label:  "Temp",
    format: v => v !== null ? `${v}°C` : "—",
    warn:   v => (v as number ?? 0) >= 45,
  },
  crc_errors: {
    label:  "CRC Err",
    format: v => v !== null ? String(v) : "—",
    warn:   v => (v as number ?? 0) > 0,
  },
}

export const DEFAULT_FOOTER_SIGNALS: Record<string, string[]> = {
  default: ["power_on_hours", "reallocated", "pending",            "uncorrected"],
  SAS:     ["power_on_hours", "reallocated", "load_unload_cycles", "uncorrected"],
}
