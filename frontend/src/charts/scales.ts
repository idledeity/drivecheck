// Axis arithmetic for the hand-rolled SVG charts: clean y ticks, the
// log(1 + v) scale the error counters use, and local-time x ticks.

const MINUTE = 60e3
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** About `count` evenly spaced round numbers (steps of 1, 2, 2.5 or 5 × 10ⁿ)
 *  covering lo..hi; the first and last tick are the domain to draw. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  // A flat series (every value equal) gets a one-unit margin each side, so
  // the line sits mid-chart instead of on a zero-height axis.
  if (hi <= lo) { hi = lo + 1; lo = lo - 1 }
  const span = hi - lo
  // The power of ten just below the ideal step (span / count), e.g. 1 for a
  // span of 19 over 4 ticks; then the smallest of 1, 2, 2.5, 5, 10 × that
  // which needs no more than `count` steps to cover the span.
  const mag = Math.pow(10, Math.floor(Math.log10(span / Math.max(1, count))))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) ?? 10 * mag
  // From the step at or below lo up to the first step at or above hi. The
  // 1e-9 slack absorbs floating-point drift (0.1 + 0.2 ≠ 0.3), and toFixed
  // trims it from the values themselves.
  const first = Math.floor(lo / step) * step
  const ticks: number[] = []
  for (let v = first; v < hi + step - 1e-9 * step; v += step) {
    ticks.push(+v.toFixed(10))
    if (v >= hi - 1e-9 * step) break
  }
  return ticks
}

/** Ticks for a log(1 + v) axis: 0, 1, 10, 100… up to the first decade at or
 *  above max (at least 10, so a run of zeros still has a scale). */
export function log1pTicks(max: number): number[] {
  const ticks = [0, 1, 10]
  while (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] * 10)
  return ticks
}

export type YScale = "linear" | "log1p"

/** A value → pixel function for a y axis spanning [lo, hi] onto [bottom, top]. */
export function yScale(scale: YScale, lo: number, hi: number, bottom: number, top: number) {
  // log1p plots log10(1 + v), so 0 maps to 0 (plain log10(0) is -∞) while
  // 9, 99, 999 still sit a decade apart. Negative values clamp to 0.
  const f = scale === "log1p" ? (v: number) => Math.log10(1 + Math.max(0, v)) : (v: number) => v
  // k: px per unit of f(value); 0 for an empty domain so nothing divides by 0.
  const a = f(lo), b = f(hi), k = b === a ? 0 : (bottom - top) / (b - a)
  return (v: number) => bottom - (f(v) - a) * k
}

/** "1,000"-style ticks under 10,000, compact ("10K", "2.5M") from there up. */
export function formatTick(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e6) return `${+(v / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${+(v / 1e3).toFixed(1)}K`
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// Candidate x-tick spacings, smallest first.
const TIME_STEPS = [
  MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY,
]

export interface TimeTick { t: number; label: string }

/** At most maxTicks x ticks between start and end (ms), on round local times:
 *  multiples of the spacing since local midnight, or whole days counted from a
 *  fixed epoch so multi-day spacings don't shift as the range moves. Sub-day
 *  ticks read "14:00", except at midnight, which reads as the date. */
export function timeTicks(start: number, end: number, maxTicks: number): TimeTick[] {
  const span = end - start
  if (!(span > 0) || maxTicks < 1) return []
  // The finest spacing that keeps the tick count within maxTicks.
  const step = TIME_STEPS.find(s => span / s <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1]
  const ticks: TimeTick[] = []
  // Walk local days, so a DST change shifts that day's ticks, not every later one.
  const day = new Date(start)
  day.setHours(0, 0, 0, 0)
  for (; day.getTime() <= end; day.setDate(day.getDate() + 1)) {
    const dayStart = day.getTime()
    // Multi-day spacing: one tick at midnight on every Nth day, counting days
    // from the Unix epoch so the same days get ticks whatever the range start.
    if (step >= DAY) {
      if (dayNumber(day) % (step / DAY) === 0 && dayStart >= start) ticks.push({ t: dayStart, label: dateLabel(dayStart) })
      continue
    }
    // Sub-day spacing: midnight, midnight + step, … up to the next midnight
    // (found by calendar, since a DST day isn't 24 hours long).
    const next = new Date(day)
    next.setDate(next.getDate() + 1)
    for (let t = dayStart; t < next.getTime() && t <= end; t += step) {
      if (t >= start) ticks.push({ t, label: t === dayStart ? dateLabel(t) : clockLabel(t) })
    }
  }
  return ticks
}

/** Days since 1970-01-01 for d's calendar date (immune to DST and time zone). */
function dayNumber(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY)
}

export function dateLabel(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function clockLabel(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** "Nov 12, 14:05" — the tooltip header for a moment. */
export function momentLabel(t: number): string {
  return `${dateLabel(t)}, ${clockLabel(t)}`
}
