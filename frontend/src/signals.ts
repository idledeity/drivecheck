import { humanizeKey } from "./format"

// The one registry of drive health signals (DCSignals fields): how each is
// labelled and formatted wherever it is shown — the card footer, the Health
// tab, a job's SMART before/after. Severity is not decided here: the backend
// flags each signal ok/warn/crit (analysis.health) and SignalValue renders
// that flag, so every view colours a value the same way.

export type Severity = "ok" | "warn" | "crit"
export type SignalFlags = Record<string, Severity>
export type SignalRaw = number | boolean | null | undefined

export type SignalDescriptor = {
  label: string                           // compact: card footer, overview tiles
  name: string                            // full: tables and lists
  format: (v: number | boolean) => string // never called with null/undefined
}

const count = (v: number | boolean) => v.toLocaleString()

export const SIGNALS: Record<string, SignalDescriptor> = {
  power_on_hours:     { label: "Power-on",   name: "Power-on hours",      format: v => `${v.toLocaleString()}h` },
  reallocated:        { label: "Realloc",    name: "Reallocated sectors", format: count },
  pending:            { label: "Pending",    name: "Pending sectors",     format: count },
  uncorrected:        { label: "Uncorr",     name: "Uncorrected errors",  format: count },
  crc_errors:         { label: "CRC Err",    name: "CRC errors",          format: count },
  load_unload_cycles: { label: "Ld/UL",      name: "Load/unload cycles",  format: count },
  temp:               { label: "Temp",       name: "Temperature",         format: v => `${v}°C` },
  reallocated_events: { label: "Realloc Ev", name: "Reallocation events", format: count },
  smart_passed:       { label: "SMART",      name: "SMART status",        format: v => (v ? "Passed" : "Failed") },
}

// The signals the Health tab's report lists, in order (smart_passed has its
// own line there; reallocated_events isn't part of the live drive payload).
export const REPORT_SIGNALS = [
  "power_on_hours", "reallocated", "pending", "uncorrected", "crc_errors", "load_unload_cycles", "temp",
]

export const DEFAULT_FOOTER_SIGNALS: Record<string, string[]> = {
  default: ["power_on_hours", "reallocated", "pending",            "uncorrected", "crc_errors"],
  SAS:     ["power_on_hours", "reallocated", "load_unload_cycles", "uncorrected"],
}

export function signalLabel(key: string): string {
  return SIGNALS[key]?.label ?? humanizeKey(key)
}

export function signalName(key: string): string {
  return SIGNALS[key]?.name ?? humanizeKey(key)
}

export function formatSignal(key: string, value: SignalRaw): string {
  if (value === null || value === undefined) return "—"
  return SIGNALS[key] ? SIGNALS[key].format(value) : String(value)
}

// Class names for a severity; pair with the base "sig-value" class (signals.css).
export function severityClass(flag: string | null | undefined): string {
  return flag === "crit" ? "sig-crit" : flag === "warn" ? "sig-warn" : ""
}

// A drive's overall health status as a severity, to colour it the same way.
export function healthSeverity(status: string | null | undefined): Severity {
  return status === "Failing" ? "crit" : status === "Degraded" ? "warn" : "ok"
}
