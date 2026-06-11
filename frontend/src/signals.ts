import type { Drive } from "./types"

export type SignalDescriptor = {
  label: string
  format: (v: Drive[keyof Drive]) => string
}

export const SIGNALS: Record<string, SignalDescriptor> = {
  power_on_hours: {
    label:  "Power-on",
    format: v => v !== null ? `${(v as number).toLocaleString()}h` : "—",
  },
  reallocated: {
    label:  "Realloc",
    format: v => v !== null ? String(v) : "—",
  },
  pending: {
    label:  "Pending",
    format: v => v !== null ? String(v) : "—",
  },
  uncorrected: {
    label:  "Uncorr",
    format: v => v !== null ? String(v) : "—",
  },
  load_unload_cycles: {
    label:  "Ld/UL",
    format: v => v !== null ? (v as number).toLocaleString() : "—",
  },
  temp: {
    label:  "Temp",
    format: v => v !== null ? `${v}°C` : "—",
  },
}

export const DEFAULT_FOOTER_SIGNALS: Record<string, string[]> = {
  default: ["power_on_hours", "reallocated", "pending",            "uncorrected"],
  SAS:     ["power_on_hours", "reallocated", "load_unload_cycles", "uncorrected"],
}
