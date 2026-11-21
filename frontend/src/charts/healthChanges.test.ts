import { describe, expect, it } from 'vitest'
import { chartDrive } from './historySeries'
import { firstReadingMarkers, healthChanges, healthMarkers, isFirstReading } from './healthChanges'
import type { DriveHistoryData, HealthPoint } from './useDriveHistory'
import type { HealthFactor } from '../types'
import { makeDrive } from '../test/fixtures'

const MIN = 60e3
const T0 = new Date(2026, 10, 16, 22, 0).getTime()
const drive = chartDrive('d1', makeDrive({ model: 'Ultrastar', serial: '1EJ6JG4J' }), { color: 'var(--s1)' })

const factor = (signal: string, label: string, value: string, role: 'start' | 'adds', points: number): HealthFactor =>
  ({ key: `curve:${signal}`, kind: 'media', label, signal, value, standalone: role === 'start' ? points : 70, weight: 1, role, points } as HealthFactor)
const point = (t: number, pct: number | null, status: string | null, factors: HealthFactor[] = []): HealthPoint =>
  ({ t, pct, status, factors, floor: null })
const history = (health: HealthPoint[], firstReadings: Record<string, number>, start = T0) => ({
  start, end: T0 + 120 * MIN, bucketMs: 5 * MIN, jobs: [],
  drives: { d1: { vitals: { t: [] }, signals: {}, health, firstReadings } },
} as unknown as DriveHistoryData)

const unc = (role: 'start' | 'adds', points: number) => factor('uncorrected', 'Uncorrected errors', '7', role, points)
const pending = factor('pending', 'Pending sectors', '108', 'start', 27.6)

describe('healthChanges', () => {
  it('names a new worst factor read for the first time as a first reading, not a change in the drive', () => {
    const data = history(
      [point(T0, 35, 'Failing', [unc('start', 39)]), point(T0 + 60 * MIN, 20, 'Failing', [pending, unc('adds', -5.9)])],
      { uncorrected: T0 - 86400e3, pending: T0 + 60 * MIN },
    )
    const [change, ...rest] = healthChanges(data, [drive])
    expect(rest).toEqual([])          // the score carried in at the start isn't a change
    expect(change).toMatchObject({ t: T0 + 60 * MIN, firstScore: false })
    expect(change.from?.pct).toBe(35)
    expect(change.why.text).toBe('Pending sectors 108 now sets the score')
    expect(isFirstReading(change)).toBe(true)
    expect(healthMarkers([change])).toEqual([{ series: 'd1', t: T0 + 60 * MIN, label: '35 → 20, first reading: Pending sectors · Ultrastar JG4J' }])
  })

  it('logs a drive first seen in the range as its first score', () => {
    const data = history([point(T0, null, null), point(T0 + 5 * MIN, 35, 'Failing', [unc('start', 39)])],
      { uncorrected: T0 + 5 * MIN, temp: T0 + 5 * MIN })
    const [change] = healthChanges(data, [drive])
    expect(change).toMatchObject({ firstScore: true, from: null })
    expect(change.why.text).toBe('First score: Uncorrected errors 7 sets it')
    expect(healthMarkers([change])[0].label).toBe('First score 35 · Ultrastar JG4J')
  })

  it('names the factor whose points moved most when the worst factor stays', () => {
    const realloc = (value: string, points: number) => factor('reallocated', 'Reallocated sectors', value, 'adds', points)
    const data = history(
      [point(T0, 35, 'Failing', [unc('start', 39), realloc('5', -3.3)]), point(T0 + 10 * MIN, 33, 'Failing', [unc('start', 39), realloc('9', -5)])],
      { uncorrected: T0 - 1, reallocated: T0 - 1 },
    )
    const [change] = healthChanges(data, [drive])
    expect(change.why.text).toBe('Reallocated sectors 5 → 9')
    expect(isFirstReading(change)).toBe(false)
    expect(healthMarkers([change])).toEqual([])
  })
})

describe('firstReadingMarkers', () => {
  it('marks each drive\'s first reading of a signal that falls in the range', () => {
    const data = history([], { pending: T0 + 60 * MIN, temp: T0 - 1 })
    expect(firstReadingMarkers(data, [drive], 'pending')).toEqual([{ series: 'd1', t: T0 + 60 * MIN, label: 'First reading: Pending sectors · Ultrastar JG4J' }])
    expect(firstReadingMarkers(data, [drive], 'temp')).toEqual([])
  })
})
