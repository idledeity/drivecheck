import type { Drive } from "./types"

export function formatCapacity(bytes: number | null): string {
  if (bytes === null) return "—"
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(0)} TB`
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(0)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
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

// Mirrors DriveCard's row-1 title (manufacturer + model + capacity) as plain text.
// Excludes the user label — DriveCard renders that with its own lower-emphasis
// styling, so callers that want it should render `drive.label` separately.
export function driveTitle(drive: Drive): string {
  const parts = [drive.manufacturer, drive.model ?? drive.device]
  if (drive.capacity_bytes) parts.push(formatCapacity(drive.capacity_bytes))
  return parts.filter(Boolean).join(" ")
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

export function formatTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  })
}

// "test_type" -> "Test type" — for rendering arbitrary job params/result keys
// without needing each operation's ParamSpec labels just for a details view.
export function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
