import { describe, expect, it } from 'vitest'
import {
  ageLabel, baselineSpread, ratioLabel, counterChanges, counterWindows, eventStatus, rateBuckets, rateLabel, rateStatus,
  settledSince, stepValue,
} from './counterTrends'

const H = 3600e3, D = 24 * H
const start = 0, end = 7 * D
const pts = (...p: [number, number | null][]) => p.map(([t, v]) => ({ t, v }))

describe('counterWindows', () => {
  it('follows the range on Auto, and compares with the rest of the range or the window before', () => {
    expect(counterWindows(start, end, '7d', 'auto', 'rest')).toEqual({ recentStart: 6 * D, baseStart: 0, label: '24h' })
    expect(counterWindows(start, end, '7d', '4h', 'prev')).toEqual({ recentStart: end - 4 * H, baseStart: end - 8 * H, label: '4h' })
  })
  it('falls back to Auto when the picked window is as long as the range', () => {
    expect(counterWindows(start, end, '7d', '7d', 'rest').label).toBe('24h')
  })
})

describe('changes and buckets', () => {
  const p = pts([0, 5], [D, 5], [2 * D, 8], [2 * D + H, 6], [3 * D, null])
  it('lists each change after the carried-in value, skipping nulls', () => {
    expect(counterChanges(p)).toEqual([{ t: 2 * D, delta: 3, value: 8 }, { t: 2 * D + H, delta: -2, value: 6 }])
    expect(stepValue(p, 4 * D)).toBe(6)
    expect(stepValue(pts([D, 1]), 0)).toBeNull()
  })
  it('nets each bucket, with nothing before the first record', () => {
    const b = rateBuckets(pts([D, 10], [D + H, 12], [3 * D, 20]), start, 4 * D, D)
    expect(b.map(q => q.delta)).toEqual([null, 2, 0, 8])
  })
  it('gives no spread under three comparison buckets', () => {
    const w = counterWindows(start, end, '7d', 'auto', 'rest')
    const b = rateBuckets(pts([0, 0], [D, 2], [2 * D, 4], [3 * D, 10]), start, end, D)
    expect(baselineSpread(b, w)).toMatchObject({ lo: 0, hi: 2, mean: 10 / 6 })
    expect(baselineSpread(b.slice(0, 2), w)).toBeNull()
  })
})

describe('eventStatus', () => {
  const w = counterWindows(start, end, '7d', 'auto', 'rest')   // recent: the last 24h
  it('sums ups and downs in the recent window', () => {
    expect(eventStatus(pts([0, 0], [end - H, 4], [end - 1, 2]), start, end, w)).toEqual({ kind: 'recent', value: 2, up: 4, down: 2 })
  })
  it('names the last change and how long ago when it was earlier', () => {
    const p = pts([0, 1028], [D, 1030])
    const s = eventStatus(p, start, end, w)!
    expect(s).toEqual({ kind: 'last', value: 1030, delta: 2, t: D })
    expect(settledSince(s, p, start)).toBe(D)
    expect(ageLabel(end - D)).toBe('6d')
  })
  it('says when an unchanged count was first recorded inside the range; no tint at 0', () => {
    const s = eventStatus(pts([2 * D, 6]), start, end, w)!
    expect(s).toEqual({ kind: 'unchanged', value: 6, since: 2 * D })
    expect(settledSince(s, pts([2 * D, 6]), start)).toBe(2 * D)
    expect(settledSince(eventStatus(pts([0, 0]), start, end, w)!, pts([0, 0]), start)).toBeNull()
  })
})

describe('rateStatus', () => {
  const w = counterWindows(start, end, '7d', 'auto', 'rest')
  const steady = (perDay: number, recentPerDay: number) => {
    // Each day's count lands mid-day, clear of the window edges.
    const p: [number, number][] = [[0, 0]]
    for (let d = 0; d < 6; d++) p.push([d * D + 12 * H, (d + 1) * perDay])
    p.push([end - 12 * H, 6 * perDay + recentPerDay])
    return pts(...p)
  }
  it('compares the recent per-day rate with the comparison window', () => {
    expect(rateStatus(steady(20, 60), start, end, w, 4 * H)).toMatchObject({ perDay: 60, basePerDay: 20, ratio: 3, trend: 'faster' })
    expect(rateStatus(steady(20, 5), start, end, w, 4 * H)).toMatchObject({ trend: 'slower' })
    expect(rateStatus(steady(20, 24), start, end, w, 4 * H)).toMatchObject({ trend: 'usual' })
    expect(rateStatus(steady(0, 3), start, end, w, 4 * H)).toMatchObject({ trend: 'new' })
    expect(rateStatus(steady(0, 0), start, end, w, 4 * H)).toMatchObject({ trend: 'none' })
  })
  it('declines to compare with under three comparison buckets', () => {
    expect(rateStatus(pts([end - D - 4 * H, 0], [end, 10]), start, end, w, 4 * H)).toMatchObject({ trend: 'short', basePerDay: null })
  })
  it('formats rates to a sensible precision', () => {
    expect([ratioLabel(3.24), ratioLabel(12.4), ratioLabel(0.004)]).toEqual(['3.2×', '12×', '<0.1×'])
    expect([rateLabel(1240.4), rateLabel(38.2), rateLabel(4.25), rateLabel(0.354), rateLabel(0)]).toEqual(['1,240', '38', '4.3', '0.35', '0'])
  })
})
