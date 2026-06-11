export function formatCapacity(bytes: number | null): string {
  if (bytes === null) return "—"
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(0)} TB`
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(0)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
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
