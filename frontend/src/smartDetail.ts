import { useCallback, useEffect, useState } from "react"
import type { SmartDetail, SmartDetailResponse, SmartField } from "./types"
import { formatDuration } from "./format"

/* Fetching and formatting for the Health -> SMART page (SmartPage.tsx). */

type Loaded = { state: "loading" } | { state: "none" } | { state: "ok"; data: SmartDetailResponse }

/**
 * A drive's latest full SMART read, fetched once: the page holds still while
 * it's read. reload() fetches it again, keeping what's shown until it lands.
 */
export function useSmartDetail(guid: string): Loaded & { reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let live = true
    fetch(`/api/drives/${guid}/smart/detail`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: SmartDetailResponse | null) => {
        if (live) setLoaded(data ? { state: "ok", data } : { state: "none" })
      })
      .catch(() => live && setLoaded({ state: "none" }))
    return () => { live = false }
  }, [guid, generation])
  const reload = useCallback(() => setGeneration(g => g + 1), [])
  return { ...loaded, reload }
}

/** Whether the drive has had a full read since the one shown, i.e. Refresh would show newer values. */
export function hasNewerRead(data: SmartDetailResponse, lastFullReadAt: string | null | undefined): boolean {
  return !!lastFullReadAt && new Date(lastFullReadAt).getTime() > new Date(data.captured_at).getTime()
}

export function hasSmartData(detail: SmartDetail): boolean {
  return detail.groups.length > 0 || (detail.attributes?.length ?? 0) > 0
}

const BYTE_UNITS: [number, string][] = [[1e15, "PB"], [1e12, "TB"], [1e9, "GB"], [1e6, "MB"], [1e3, "KB"]]

export function formatBytes(bytes: number): string {
  for (const [size, unit] of BYTE_UNITS) {
    if (bytes >= size) return `${(bytes / size).toFixed(bytes >= size * 100 ? 0 : 1)} ${unit}`
  }
  return `${bytes} B`
}

export function formatFieldValue(field: Pick<SmartField, "value" | "unit">): string {
  const { value, unit } = field
  if (value === null) return "—"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "string") return unit === "celsius" ? `${value} °C` : value
  switch (unit) {
    case "hours":   return `${value.toLocaleString()} h`
    case "minutes": return value >= 60 ? formatDuration(value * 60) : `${value} min`
    case "seconds": return formatDuration(value)
    case "ms":      return `${value.toLocaleString()} ms`
    case "celsius": return `${value} °C`
    case "bytes":   return formatBytes(value)
    case "percent": return `${value}%`
    default:        return value.toLocaleString()
  }
}
