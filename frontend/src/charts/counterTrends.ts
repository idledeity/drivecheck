import { numeric } from "./chartGeometry"
import { formatCount } from "./scales"
import type { ChartPoint } from "./chartGeometry"
import type { HistoryRange } from "./useDriveHistory"

// The facts behind a counter's Events and Rate views, and the status line
// each drive gets in them: when it changed, by how much, and how its recent
// rate compares with before. All derived when drawn, from the step series
// the history route serves (the first point is the value carried in from
// before the range, or the first one ever recorded).

export type CounterView = "total" | "events" | "rate"

// ── windows ──────────────────────────────────────────────────────────────────

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR

/** The recent window as picked in a Trends counter card's subtitle; "auto" follows the range. */
export const RECENT_WINDOWS = ["auto", "1h", "4h", "24h", "7d", "30d"] as const
export type RecentWindow = typeof RECENT_WINDOWS[number]
const WINDOW_MS: Record<Exclude<RecentWindow, "auto">, number> = { "1h": HOUR, "4h": 4 * HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY }

/** What the recent window is compared against: everything earlier in the
 *  range, or just the same length of time right before it. */
export type Baseline = "rest" | "prev"

// About a sixth of the range, rounded to a length people say.
const AUTO_WINDOW: Record<HistoryRange, { ms: number; label: string }> = {
  "1h": { ms: 15 * MIN, label: "15 min" },
  "8h": { ms: HOUR, label: "1h" },
  "24h": { ms: 4 * HOUR, label: "4h" },
  "7d": { ms: DAY, label: "24h" },
  "30d": { ms: 7 * DAY, label: "7d" },
  "90d": { ms: 7 * DAY, label: "7d" },
}

/** Rate bars per range: 20–45 bars, each a whole number of the recent window's
 *  parts, so the window starts on a bar edge. */
export const RATE_BUCKET: Record<HistoryRange, { ms: number; label: string }> = {
  "1h": { ms: 5 * MIN, label: "5 min" },
  "8h": { ms: 20 * MIN, label: "20 min" },
  "24h": { ms: HOUR, label: "hour" },
  "7d": { ms: 4 * HOUR, label: "4 h" },
  "30d": { ms: DAY, label: "day" },
  "90d": { ms: DAY, label: "day" },
}

export const autoWindowLabel = (range: HistoryRange) => AUTO_WINDOW[range].label

/** Whether a picked window fits a range: it must be shorter than the range,
 *  or there's nothing left to compare it with. */
export const windowFits = (w: RecentWindow, rangeMs: number) =>
  w === "auto" || WINDOW_MS[w] < rangeMs

export interface CounterWindows {
  /** Where the recent window starts; it runs to the range's end. */
  recentStart: number
  /** Where the comparison starts; it runs to recentStart. */
  baseStart: number
  /** "24h": the recent window as status lines name it. */
  label: string
}

/** The recent and comparison windows for a range. A picked window too long
 *  for the range falls back to the range's own (Auto). */
export function counterWindows(start: number, end: number, range: HistoryRange, recent: RecentWindow, baseline: Baseline): CounterWindows {
  const picked = recent !== "auto" && windowFits(recent, end - start)
  const ms = picked ? WINDOW_MS[recent as Exclude<RecentWindow, "auto">] : AUTO_WINDOW[range].ms
  const label = picked ? recent : AUTO_WINDOW[range].label
  const recentStart = end - ms
  return { recentStart, baseStart: baseline === "prev" ? Math.max(start, recentStart - ms) : start, label }
}

// ── facts ────────────────────────────────────────────────────────────────────

/** The value in force at t (the latest point at or before it), or null before the first. */
export function stepValue(points: ChartPoint[], t: number): number | null {
  let v: number | null = null
  for (const p of numeric(points)) {
    if (p.t > t) break
    v = p.v
  }
  return v
}

/** When the series was first recorded (its first numeric point), or null. */
export const firstRecord = (points: ChartPoint[]): number | null => numeric(points)[0]?.t ?? null

export interface CounterChange { t: number; delta: number; value: number }

/** Every change after the first point: when, by how much, and to what. */
export function counterChanges(points: ChartPoint[]): CounterChange[] {
  const pts = numeric(points), out: CounterChange[] = []
  for (let i = 1; i < pts.length; i++) {
    const delta = pts[i].v - pts[i - 1].v
    if (delta !== 0) out.push({ t: pts[i].t, delta, value: pts[i].v })
  }
  return out
}

export interface RateBucket {
  start: number
  end: number
  /** The net change in the bucket; null before the series was first recorded. */
  delta: number | null
}

/** The net change from `from` up to (not including) `to` — a change exactly
 *  on a boundary belongs to the span it starts — except that a span ending at
 *  the range's end takes a change made right at the end too. */
export function netChange(changes: CounterChange[], from: number, to: number, rangeEnd: number): number {
  let sum = 0
  for (const c of changes) if (c.t >= from && (c.t < to || (to >= rangeEnd && c.t <= rangeEnd))) sum += c.delta
  return sum
}

/** Fixed buckets from start, each with the counter's net change across it. */
export function rateBuckets(points: ChartPoint[], start: number, end: number, size: number): RateBucket[] {
  const first = firstRecord(points), changes = counterChanges(points), out: RateBucket[] = []
  for (let s = start; s < end; s += size) {
    const e = Math.min(s + size, end)
    out.push({ start: s, end: e, delta: first === null || e <= first ? null : netChange(changes, s, e, end) })
  }
  return out
}

/** The comparison buckets' spread, for the Rate view's band: the middle half
 *  (25th–75th percentile) and the mean. Null under 3 buckets, too few to say
 *  what's usual. */
export function baselineSpread(buckets: RateBucket[], w: CounterWindows): { lo: number; hi: number; mean: number } | null {
  const ds = comparisonBuckets(buckets, w).map(b => b.delta!)
  if (ds.length < 3) return null
  const sorted = [...ds].sort((a, b) => a - b)
  const q = (p: number) => {
    const i = (sorted.length - 1) * p, lo = Math.floor(i)
    return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
  }
  return { lo: q(0.25), hi: q(0.75), mean: ds.reduce((a, b) => a + b, 0) / ds.length }
}

const comparisonBuckets = (buckets: RateBucket[], w: CounterWindows) =>
  buckets.filter(b => b.delta !== null && b.start >= w.baseStart && b.end <= w.recentStart)

// ── status ───────────────────────────────────────────────────────────────────

/** An error counter's status line, e.g. "+23 in last 24h" or "last +2 · 61d ago". */
export type EventStatus =
  /** Changed in the recent window: the increases and decreases in it. */
  | { kind: "recent"; value: number; up: number; down: number }
  /** Changed earlier in the range, not since. */
  | { kind: "last"; value: number; delta: number; t: number }
  /** No change; since is when it was first recorded, if that's inside the range. */
  | { kind: "unchanged"; value: number; since: number | null }

export function eventStatus(points: ChartPoint[], start: number, end: number, w: CounterWindows): EventStatus | null {
  const value = stepValue(points, end), first = firstRecord(points)
  if (value === null || first === null) return null
  const changes = counterChanges(points)
  const recent = changes.filter(c => c.t >= w.recentStart)
  if (recent.length) {
    return {
      kind: "recent", value,
      up: recent.reduce((a, c) => a + Math.max(0, c.delta), 0),
      down: recent.reduce((a, c) => a + Math.max(0, -c.delta), 0),
    }
  }
  const last = changes.at(-1)
  if (last) return { kind: "last", value, delta: last.delta, t: last.t }
  return { kind: "unchanged", value, since: first > start ? first : null }
}

/** Since when the Events view tints a lane as settled: the last change, or the
 *  first record of a non-zero count that never changed. Nothing for a count
 *  that's 0 throughout — no tint is the calm state. */
export function settledSince(status: EventStatus, points: ChartPoint[], start: number): number | null {
  if (status.kind === "unchanged") return status.value === 0 ? null : Math.max(start, firstRecord(points) ?? start)
  return counterChanges(points).at(-1)?.t ?? null
}

/** How much faster or slower than usual, as the status line says it. */
export type RateTrend = "faster" | "slower" | "usual" | "new" | "none" | "short"

/** A wear counter's status line: per day in the recent window, against the
 *  comparison window. "short" when there are under 3 comparison buckets,
 *  "new" when it was flat before and isn't now, "none" when flat throughout. */
export interface RateStatus { perDay: number; basePerDay: number | null; ratio: number | null; trend: RateTrend }

// At or beyond these, a rate reads as faster / slower than usual.
export const FASTER = 1.5, SLOWER = 0.67

export function rateStatus(points: ChartPoint[], start: number, end: number, w: CounterWindows, bucketMs: number): RateStatus | null {
  const first = firstRecord(points)
  if (first === null) return null
  const changes = counterChanges(points)
  const perDay = (from: number, to: number) => {
    const s = Math.max(from, first)
    return to > s ? (netChange(changes, s, to, end) / (to - s)) * DAY : null
  }
  const recent = perDay(w.recentStart, end) ?? 0
  if (comparisonBuckets(rateBuckets(points, start, end, bucketMs), w).length < 3) {
    return { perDay: recent, basePerDay: null, ratio: null, trend: "short" }
  }
  const base = perDay(w.baseStart, w.recentStart) ?? 0
  if (base === 0) return { perDay: recent, basePerDay: 0, ratio: null, trend: recent === 0 ? "none" : "new" }
  const ratio = recent / base
  return { perDay: recent, basePerDay: base, ratio, trend: ratio >= FASTER ? "faster" : ratio <= SLOWER ? "slower" : "usual" }
}

/** "3h", "61d": how long ago, in the largest unit that keeps it short. */
export function ageLabel(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)}h`
  return `${Math.round(ms / DAY)}d`
}

/** "3.2×", "12×", "<0.1×": a rate against its usual. Under 0.1 the digits
 *  would round to a meaningless "0.0×". */
export function ratioLabel(ratio: number): string {
  if (ratio < 0.1) return "<0.1×"
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`
}

/** A per-day rate, to a sensible precision: 1,240 · 38 · 4.2 · 0.35. */
export function rateLabel(perDay: number): string {
  const a = Math.abs(perDay)
  if (a >= 100) return formatCount(Math.round(perDay))
  if (a >= 10) return perDay.toFixed(0)
  if (a >= 1) return perDay.toFixed(1)
  return a === 0 ? "0" : perDay.toFixed(2)
}
