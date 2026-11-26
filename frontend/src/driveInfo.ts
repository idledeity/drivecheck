import { useEffect, useState } from "react"
import { formatBytes } from "./format"

/* A drive's physical attributes (GET /api/drives/info, backend
   analysis/drive_info.py): Info tab and the Report's drive section. */

export type DriveInfoRow = {
  key: string
  label: string
  value: string | number
  format: "text" | "bytes" | "size" | "count"
  /** Set when this row was read at a different time than its group. */
  as_of?: string
}

export type DriveInfoGroup = {
  id: string
  title: string
  as_of: string | null
  rows: DriveInfoRow[]
}

export type DriveInfo = { groups: DriveInfoGroup[] }

type Loaded =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; data: Record<string, DriveInfo> }

/**
 * Info for the given drives, fetched when the set changes. These values
 * rarely change (identity: the daily traits read; connection: each scan),
 * so no polling; while a new set loads the previous one stays shown.
 */
export function useDriveInfo(guids: string[]): Loaded {
  const key = guids.join(",")
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  useEffect(() => {
    if (!key) return
    let live = true
    fetch(`/api/drives/info?guids=${encodeURIComponent(key)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Record<string, DriveInfo>) => { if (live) setLoaded({ state: "ok", data }) })
      .catch(() => { if (live) setLoaded(prev => (prev.state === "ok" ? prev : { state: "error" })) })
    return () => { live = false }
  }, [key])
  return loaded
}

export function formatInfoValue(row: Pick<DriveInfoRow, "value" | "format">): string {
  const { value, format } = row
  if (typeof value === "string") return value
  switch (format) {
    case "bytes": return `${formatBytes(value)} (${value.toLocaleString()} bytes)`
    case "size":  return `${value.toLocaleString()} bytes`
    case "count": return value.toLocaleString()
    default:      return String(value)
  }
}

/** The groups as plain-text lines, for the downloaded report. */
export function driveInfoText(info: DriveInfo): string[] {
  const width = Math.max(0, ...info.groups.flatMap(g => g.rows.map(r => r.label.length))) + 2
  return info.groups.flatMap(group => [
    `${group.title}:`,
    ...group.rows.map(r => `  ${(r.label + ":").padEnd(width)}${formatInfoValue(r)}`),
    ``,
  ])
}

/** Every group and row key across several drives, for the side-by-side
    table (a drive without a row shows a blank cell). Each drive's own order
    is kept: a key only some drives have goes in right after the row it
    follows on those drives, not at the end. */
export function unionLayout(infos: DriveInfo[]): { id: string; title: string; rows: { key: string; label: string }[] }[] {
  const groups: { id: string; title: string; rows: { key: string; label: string }[] }[] = []
  for (const info of infos) {
    for (const g of info.groups) {
      let group = groups.find(x => x.id === g.id)
      if (!group) {
        group = { id: g.id, title: g.title, rows: [] }
        groups.push(group)
      }
      const rows = group.rows
      g.rows.forEach((r, i) => {
        if (rows.some(x => x.key === r.key)) return
        const after = i === 0 ? -1 : rows.findIndex(x => x.key === g.rows[i - 1].key)
        rows.splice(after + 1, 0, { key: r.key, label: r.label })
      })
    }
  }
  return groups
}
