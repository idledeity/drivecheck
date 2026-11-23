import type { Job } from "./types"

export function formatCapacity(bytes: number | null): string {
  if (bytes === null) return "—"
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(0)} TB`
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(0)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

export function formatThroughput(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return "—"
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`
  return `${bytesPerSec.toFixed(0)} B/s`
}

export function formatPercent(pct: number | null): string {
  if (pct === null) return "—"
  return `${pct.toFixed(0)}%`
}

export function formatRelativeTime(isoTimestamp: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(isoTimestamp).getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** Just the clock time, e.g. "14:05" (locale's format). */
export function formatClock(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function formatTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  })
}

// "Today", "Yesterday", or a short date ("Nov 8"; with the year when it isn't
// the current one) for the day containing `t`, relative to `now` (both ms).
export function dayLabel(t: number, now: number): string {
  const d = new Date(t)
  if (d.toDateString() === new Date(now).toDateString()) return "Today"
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  })
}

// A time (ms) as the backend stores and reads times: ISO 8601 in UTC
// ("2026-11-12T01:30:00.000Z"), for filters like `since` and saved settings
// like jobs_seen_at. (Older saved values have no offset: local time, which
// new Date() still reads correctly.)
export function toServerIso(t: number): string {
  return new Date(t).toISOString()
}

// "test_type" -> "Test type" — for rendering arbitrary job params/result keys
// without needing each operation's ParamSpec labels just for a details view.
export function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The one-line outcome shown as "Result" for every job.
export function jobResultText(job: Job): string {
  switch (job.status) {
    case "completed":   return job.summary ?? "Completed"
    case "failed":      return job.error ?? "Failed"
    case "interrupted": return job.error ?? "Interrupted by a backend restart"
    case "cancelled":   return "Cancelled before it finished"
    case "running":     return job.progress.message ?? "In progress"
    case "queued":      return "Waiting to start"
    case "skipped":     return job.error ?? "Skipped"
  }
}

const BYTE_UNITS: [number, string][] = [[1e15, "PB"], [1e12, "TB"], [1e9, "GB"], [1e6, "MB"], [1e3, "KB"]]

export function formatBytes(bytes: number): string {
  for (const [size, unit] of BYTE_UNITS) {
    if (bytes >= size) return `${(bytes / size).toFixed(bytes >= size * 100 ? 0 : 1)} ${unit}`
  }
  return `${bytes} B`
}

// A job or plan step's setting value, as the UI shows it.
export function formatSettingValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No"
  // Significant digits, not the default 3 fraction digits: 0.0004 must not show as 0.
  if (typeof value === "number") return value.toLocaleString(undefined, { maximumSignificantDigits: 15 })
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
