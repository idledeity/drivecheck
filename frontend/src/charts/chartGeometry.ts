// Path data and value lookup for TimeSeriesChart, kept apart so they can be
// tested (and reused) without rendering.

import type { ReactNode } from "react"

export interface ChartPoint { t: number; v: number | null }

export interface ChartSeries {
  id: string
  label: string
  /** End-of-line label; defaults to label. */
  shortLabel?: string
  color: string
  dash?: string
  points: ChartPoint[]
  /** line (default): points joined. step: each value holds until the next
   *  point, and the last until the chart's end. */
  shape?: "line" | "step"
  area?: boolean
  /** Replaces the tooltip row's line key and label, e.g. with a drive chip
   *  (which should then carry the line key itself). */
  tipLabel?: ReactNode
}

interface SeriesGeometry { line: string; area: string | null; last: { x: number; y: number } | null }

/** SVG path data for one series. Lines break at nulls and at gaps longer
 *  than gapMs; a step series' last value is drawn on to `end`. */
export function seriesPaths(
  s: ChartSeries,
  x: (t: number) => number,
  y: (v: number) => number,
  end: number,
  gapMs: number,
  baseline: number,
): SeriesGeometry {
  // Coordinates to one decimal: plenty for screen px, and keeps path strings short.
  const f = (n: number) => n.toFixed(1)
  const step = s.shape === "step"
  // `line` is one path for the whole series; each break starts a new subpath
  // with M (move) instead of L/H/V (draw), so gaps are left blank.
  let line = "", area = ""
  // The vertices of the current unbroken run, collected so its area can be
  // closed down to the baseline once the run ends.
  let run: { x: number; y: number }[] = []
  let prevT: number | null = null
  let last: { x: number; y: number } | null = null
  const by = y(baseline)

  // End the current run: if the series has an area, add the run's outline
  // dropped to the baseline at both ends and closed (Z) as a filled shape.
  const flush = () => {
    if (run.length && s.area) {
      area += `M${f(run[0].x)},${f(by)}` + run.map(p => `L${f(p.x)},${f(p.y)}`).join("") + `L${f(run[run.length - 1].x)},${f(by)}Z`
    }
    run = []
  }

  s.points.forEach((p, i) => {
    // A null value is an explicit gap: end the run; the next point starts afresh.
    if (p.v === null) { flush(); prevT = null; return }
    const px = x(p.t), py = y(p.v)
    // Start a new subpath at the first point, after a null, or (for lines)
    // after a gap in time. A step series never breaks on time: its value
    // holds however long until the next change.
    const breaks = prevT === null || (!step && p.t - prevT > gapMs)
    if (breaks) {
      flush()
      line += `M${f(px)},${f(py)}`
      run.push({ x: px, y: py })
    } else if (step) {
      // Flat across to this point's time at the old value, then straight up
      // or down to the new one.
      line += `H${f(px)}V${f(py)}`
      run.push({ x: px, y: run[run.length - 1].y }, { x: px, y: py })
    } else {
      line += `L${f(px)},${f(py)}`
      run.push({ x: px, y: py })
    }
    prevT = p.t
    last = { x: px, y: py }
    // A step's value holds until something replaces it: on to the chart's
    // end after the last point, or up to the next point's time before a null.
    if (step && (i === s.points.length - 1 || s.points[i + 1].v === null)) {
      const until = i === s.points.length - 1 ? x(end) : x(s.points[i + 1].t)
      line += `H${f(until)}`
      run.push({ x: until, y: py })
      last = { x: until, y: py }
    }
  })
  flush()
  return { line, area: s.area && area ? area : null, last }
}

/** The series' value at t: a step series' latest point at or before t; a
 *  line's point at t (within half a snap, when snapping to buckets). */
export function valueAt(s: ChartSeries, t: number, snapMs?: number): number | null {
  const pts = s.points
  if (s.shape === "step") {
    // Binary search for the last point at or before t (points are time-sorted).
    let lo = 0, hi = pts.length - 1, found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (pts[mid].t <= t) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    return found < 0 ? null : pts[found].v
  }
  // A line has values only at its points: take the nearest, but only if it's
  // in the hovered bucket — otherwise a missing bucket would show its
  // neighbour's value.
  const i = nearestIndex(pts.map(p => p.t), t)
  if (i < 0) return null
  return Math.abs(pts[i].t - t) <= (snapMs ? snapMs / 2 : 0) ? pts[i].v : null
}

/** Index of the value in sorted closest to t (-1 if empty): a binary search
 *  narrows to the two values either side of t, then picks the closer. */
function nearestIndex(sorted: number[], t: number): number {
  if (!sorted.length) return -1
  let lo = 0, hi = sorted.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= t) lo = mid; else hi = mid
  }
  return Math.abs(sorted[hi] - t) < Math.abs(sorted[lo] - t) ? hi : lo
}

export function nearest(sorted: number[], t: number): number | null {
  const i = nearestIndex(sorted, t)
  return i < 0 ? null : sorted[i]
}
