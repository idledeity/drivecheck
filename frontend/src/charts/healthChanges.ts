import type { HealthFactor } from "../types"
import { SIGNALS } from "../signals"
import type { ChartMarker } from "./TimeSeriesChart"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData, HealthPoint } from "./useDriveHistory"

// The health change log: each time a charted drive's score moved, what moved
// it — read off the factors served with each health point. A value read for
// the first time (a new drive, or a signal a newer probe added) is called a
// first reading, so it doesn't pass for the drive getting worse.

export interface HealthChange {
  drive: ChartDrive
  t: number
  /** The score before (null for a drive's first score). */
  from: HealthPoint | null
  to: HealthPoint
  /** The drive had never been scored before t. */
  firstScore: boolean
  /** What moved it, in words: the factor and how. */
  why: { factor: HealthFactor | null; text: string }
  /** Signals the drive reported for the first time at t. */
  firsts: Set<string>
}

/** Every score change of the charted drives in the range, newest first. A
 *  drive's score carried in from before the range isn't a change. */
export function healthChanges(data: DriveHistoryData, drives: ChartDrive[]): HealthChange[] {
  const changes: HealthChange[] = []
  for (const drive of drives) {
    const d = data.drives[drive.guid]
    if (!d) continue
    const firstAt = Object.values(d.firstReadings)
    // Never scored before the range: nothing was read before it.
    const newInRange = firstAt.length > 0 && Math.min(...firstAt) >= data.start
    let prev: HealthPoint | null = null
    for (const to of d.health) {
      if (to.pct === null) continue
      const firstScore = prev === null && newInRange
      if ((prev && (prev.pct !== to.pct || prev.status !== to.status)) || firstScore) {
        const firsts = new Set(Object.entries(d.firstReadings).filter(([, ft]) => ft === to.t).map(([name]) => name))
        changes.push({ drive, t: to.t, from: prev, to, firstScore, why: whyChanged(prev, to), firsts })
      }
      prev = to
    }
  }
  return changes.sort((a, b) => b.t - a.t)
}

/** The factor that moved a score from `from` to `to`: a new worst factor
 *  (which sets the score), else the one whose points moved most. */
function whyChanged(from: HealthPoint | null, to: HealthPoint): HealthChange["why"] {
  const setter = to.factors.find(f => f.role === "start") ?? null
  if (!from) {
    return setter
      ? { factor: setter, text: `First score: ${setter.label} ${setter.value} sets it` }
      : { factor: null, text: "First score: nothing lowers it" }
  }
  const before = new Map(from.factors.map(f => [f.key, f]))
  if (setter && before.get(setter.key)?.role !== "start") {
    return { factor: setter, text: `${setter.label} ${setter.value} now sets the score` }
  }
  // The rest: each factor's change in points (new ones from 0, gone ones to 0).
  const after = new Map(to.factors.map(f => [f.key, f]))
  let best: { factor: HealthFactor; old: HealthFactor | undefined; delta: number } | null = null
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key), now = after.get(key)
    const delta = Math.abs((now?.points ?? 0) - (old?.points ?? 0))
    if ((old?.value !== now?.value || delta > 0) && (!best || delta > best.delta)) {
      best = { factor: (now ?? old)!, old, delta }
    }
  }
  if (!best) return { factor: null, text: "Score changed" }
  const { factor, old } = best
  if (!after.has(factor.key)) return { factor, text: `${factor.label} no longer lowers it` }
  if (!old) return { factor, text: `${factor.label} ${factor.value} now lowers it` }
  return { factor, text: old.value === factor.value ? `${factor.label} ${factor.value}` : `${factor.label} ${old.value} → ${factor.value}` }
}

/** The signals behind a change's factors that were first read at its time:
 *  what makes it a first reading rather than the drive getting worse. */
export function firstReadFactors(change: HealthChange): HealthFactor[] {
  return change.to.factors.filter(f => f.signal !== null && change.firsts.has(f.signal))
}

/** Whether a change came from a first reading: the drive's first score, or
 *  the factor that moved it was read for the first time then. */
export function isFirstReading(change: HealthChange): boolean {
  return change.firstScore || (change.why.factor?.signal != null && change.firsts.has(change.why.factor.signal))
}

/** Markers for the health chart: the changes that came from a first reading. */
export function healthMarkers(changes: HealthChange[]): ChartMarker[] {
  return changes.filter(isFirstReading).map(c => ({
    series: c.drive.guid,
    t: c.t,
    // The score's move, since a bucket's reading shows the score at its start.
    label: c.firstScore
      ? `First score ${c.to.pct} · ${c.drive.label}`
      : `${c.from?.pct} → ${c.to.pct}, first reading: ${c.why.factor!.label} · ${c.drive.label}`,
  }))
}

/** Markers for one signal's chart: each charted drive's first reading of it,
 *  where that falls in the range. */
export function firstReadingMarkers(data: DriveHistoryData, drives: ChartDrive[], signal: string): ChartMarker[] {
  const name = SIGNALS[signal]?.name ?? signal
  return drives.flatMap(d => {
    const t = data.drives[d.guid]?.firstReadings[signal]
    return t !== undefined && t >= data.start && t <= data.end
      ? [{ series: d.guid, t, label: `First reading: ${name} · ${d.label}` }]
      : []
  })
}
