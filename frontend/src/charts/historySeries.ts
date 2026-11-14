import type { Drive } from "../types"
import type { ChartSpan } from "./TimeSeriesChart"
import type { SeriesStyle } from "./drivePalette"
import type { DriveHistoryData, HistoryJob } from "./useDriveHistory"
import { clockLabel } from "./scales"

// Shared glue between drive history data and the charts: who's charted, in
// what color, and the jobs shaded behind every chart.

/** One drive as the history charts show it. */
export interface ChartDrive {
  guid: string
  /** "Exos X16 FF02": name plus serial tail, for tooltips and the change log. */
  label: string
  style: SeriesStyle
  /** The drive record, for drive chips (absent if the drive isn't known).
   *  Charts are memoized on names, so its live fields (health) can lag the
   *  latest poll; chips here only show identity. */
  drive?: Drive
}

export function chartDrive(guid: string, drive: Drive | undefined, style: SeriesStyle): ChartDrive {
  const name = drive ? drive.label ?? drive.model ?? drive.device : "Unknown drive"
  const tail = drive?.serial ? drive.serial.slice(-4) : null
  return {
    guid,
    label: tail ? `${name} ${tail}` : name,
    style,
    drive,
  }
}

/** Jobs of the charted drives as shaded spans (neutral: the tooltip names the drive). */
export function jobSpans(data: DriveHistoryData, drives: ChartDrive[]): ChartSpan[] {
  const byGuid = new Map(drives.map(d => [d.guid, d]))
  return data.jobs
    .filter(j => byGuid.has(j.drive_guid))
    .map(j => ({ id: j.id, start: j.start, end: j.end, label: j.operation_name }))
}

/** Each charted drive's job running at any point in the bucket starting at
 *  t, for the tooltip (see JobsDuring). */
export function jobsDuring(data: DriveHistoryData, drives: ChartDrive[], t: number): { id: string; name: string; drive: ChartDrive }[] {
  const byGuid = new Map(drives.map(d => [d.guid, d]))
  const bucketEnd = t + data.bucketMs
  return data.jobs
    .filter((j: HistoryJob) => byGuid.has(j.drive_guid) && j.start < bucketEnd && (j.end ?? Infinity) >= t)
    .map(j => ({ id: j.id, name: j.operation_name, drive: byGuid.get(j.drive_guid)! }))
}

/** The vitals value of one drive at bucket start t (null if it has none). */
export function vitalAt(data: DriveHistoryData, guid: string, field: "temp_min" | "temp_max" | "read_bps" | "write_bps", t: number): number | null {
  const v = data.drives[guid]?.vitals
  if (!v) return null
  const i = v.t.indexOf(t)
  return i < 0 ? null : v[field][i]
}

/** "Nov 12, 14:05–14:10": a bucket as a span of time, for tooltip headers. */
export function bucketLabel(t: number, bucketMs: number): string {
  const day = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return `${day}, ${clockLabel(t)}–${clockLabel(t + bucketMs)}`
}

/** The highest bucket maximum of any charted drive: the temperature callout. */
export function hottest(data: DriveHistoryData, drives: ChartDrive[]): { value: number; drive: ChartDrive; t: number } | null {
  let best: { value: number; drive: ChartDrive; t: number } | null = null
  for (const d of drives) {
    const v = data.drives[d.guid]?.vitals
    v?.temp_max.forEach((value, i) => {
      if (value !== null && (!best || value > best.value)) best = { value, drive: d, t: v.t[i] }
    })
  }
  return best
}

/** The busiest bucket (read + write) of any charted drive: the throughput callout. */
export function peakThroughput(data: DriveHistoryData, drives: ChartDrive[]): { value: number; drive: ChartDrive; t: number } | null {
  let best: { value: number; drive: ChartDrive; t: number } | null = null
  for (const d of drives) {
    const v = data.drives[d.guid]?.vitals
    v?.t.forEach((t, i) => {
      const value = (v.read_bps[i] ?? 0) + (v.write_bps[i] ?? 0)
      if (!best || value > best.value) best = { value, drive: d, t }
    })
  }
  return best
}

/** A bucket's average temperature to the nearest 0.5 °C. Drives report whole
 *  degrees, so one sitting near a boundary flips between two readings
 *  (31, 32, 31, 31, 32…), and the raw average then wiggles with how many
 *  flips happened to land in each bucket. Half a degree is all the readings
 *  can honestly say: a steady flip-flop holds at 31.5, a lone blip is ignored,
 *  and a real warm-up still shows. */
export function roundTemp(avg: number | null): number | null {
  return avg === null ? null : Math.round(avg * 2) / 2
}
