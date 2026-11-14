import type { Drive } from "../types"
import type { ChartPoint, ChartSpan, ChartThreshold } from "./TimeSeriesChart"
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

/** One signal of one drive as step points: numbers only (a boolean or null
 *  value breaks the line). Empty if the drive doesn't report the signal. */
export function signalPoints(data: DriveHistoryData, guid: string, name: string): ChartPoint[] {
  return (data.drives[guid]?.signals[name] ?? []).map(p => ({ t: p.t, v: typeof p.value === "number" ? p.value : null }))
}

/** One drive's health score as step points (null before it was first scored). */
export function healthPoints(data: DriveHistoryData, guid: string): ChartPoint[] {
  return (data.drives[guid]?.health ?? []).map(h => ({ t: h.t, v: h.pct }))
}

/** A drive's health status as served at time t (the latest change at or before it). */
export function healthStatusAt(data: DriveHistoryData, guid: string, t: number): string | null {
  const health = data.drives[guid]?.health ?? []
  return health.findLast(h => h.t <= t)?.status ?? null
}

/** First and last numeric values of a step series within the range, or null
 *  when it has none. */
function firstLast(points: ChartPoint[]): { from: number; to: number } | null {
  const vals = points.flatMap(p => (p.v === null ? [] : [p.v]))
  return vals.length ? { from: vals[0], to: vals[vals.length - 1] } : null
}

export interface DriveChange { drive: ChartDrive; from: number; to: number }

/** Per charted drive, how one counter moved over the range, split into the
 *  drives whose value changed (biggest change first), the ones that report it
 *  without change, and the ones that don't report it at all (e.g. SAS drives
 *  have no pending-sector or CRC counts). */
export function counterSummary(data: DriveHistoryData, drives: ChartDrive[], name: string) {
  const changed: DriveChange[] = [], steady: DriveChange[] = [], missing: ChartDrive[] = []
  for (const d of drives) {
    const fl = firstLast(signalPoints(data, d.guid, name))
    if (!fl) missing.push(d)
    else (fl.to !== fl.from ? changed : steady).push({ drive: d, ...fl })
  }
  changed.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
  return { changed, steady, missing }
}

/** The health callout: drives whose score fell over the range (largest fall
 *  first), and the lowest current score. */
export function healthSummary(data: DriveHistoryData, drives: ChartDrive[]) {
  const dropped: DriveChange[] = []
  let lowest: { value: number; drive: ChartDrive } | null = null
  for (const d of drives) {
    const fl = firstLast(healthPoints(data, d.guid))
    if (!fl) continue
    if (fl.to < fl.from) dropped.push({ drive: d, ...fl })
    if (!lowest || fl.to < lowest.value) lowest = { value: fl.to, drive: d }
  }
  dropped.sort((a, b) => (a.to - a.from) - (b.to - b.from))
  return { dropped, lowest }
}

/** A counter's warning / critical lines, split by whether the chart should
 *  reach for them. Error counters warn at 1, which is always worth keeping in
 *  view. A wear counter's limit (load/unload cycles: 500,000) can sit hundreds
 *  of times above every drive's value; stretching the axis to it would flatten
 *  every line onto the baseline, so it's named in words instead. In view: up
 *  to ten times the highest value charted (and always 10 or below). */
export function counterThresholds(data: DriveHistoryData, drives: ChartDrive[], signal: string): { inView: ChartThreshold[]; beyond: ChartThreshold[] } {
  const limits = data.thresholds.signals[signal]
  const all: ChartThreshold[] = []
  if (limits?.warn_gte != null) all.push({ value: limits.warn_gte, label: `warning ≥ ${limits.warn_gte.toLocaleString()}`, tone: "warn" })
  if (limits?.crit_gte != null) all.push({ value: limits.crit_gte, label: `critical ≥ ${limits.crit_gte.toLocaleString()}`, tone: "crit" })
  const max = Math.max(0, ...drives.flatMap(d => signalPoints(data, d.guid, signal).flatMap(p => (p.v === null ? [] : [p.v]))))
  const reach = Math.max(10, max * 10)
  return { inView: all.filter(th => th.value <= reach), beyond: all.filter(th => th.value > reach) }
}
