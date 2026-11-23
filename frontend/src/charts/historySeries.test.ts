import { describe, expect, it } from 'vitest'
import { bucketLabel, chartDrive, dataGaps, jobsDuring, jobSpans, roundTemp } from './historySeries'
import type { DriveHistoryData, HistoryJob } from './useDriveHistory'
import { makeDrive } from '../test/fixtures'

const MIN = 60e3
const T0 = new Date(2026, 10, 13, 12, 0).getTime()
const style = { color: 'var(--s1)' }

const job = (o: Partial<HistoryJob>): HistoryJob => ({
  id: 'j', drive_guid: 'd1', operation: 'badblocks', operation_name: 'Bad Block Scan', category: 'Surface',
  status: 'completed', summary: null, error: null, started_at: '', finished_at: null, start: T0, end: T0 + 10 * MIN, ...o,
})
const data = (jobs: HistoryJob[]) => ({ start: T0, end: T0 + 60 * MIN, bucketMs: 5 * MIN, jobs } as unknown as DriveHistoryData)

describe('chartDrive', () => {
  it('names a drive by label or model plus its serial tail', () => {
    expect(chartDrive('d1', makeDrive({ model: 'Exos X16', serial: 'ZTM0FF02' }), style)).toMatchObject({ label: 'Exos X16 FF02' })
    expect(chartDrive('d1', makeDrive({ label: 'booop', model: 'X316', serial: 'ZAD1V2H0' }), style).label).toBe('booop V2H0')
    expect(chartDrive('gone', undefined, style).label).toBe('Unknown drive')
  })
})

describe('jobs', () => {
  const d1 = chartDrive('d1', makeDrive({ model: 'Exos X16', serial: 'ZTM0FF02' }), style)

  it('shades only the charted drives\' jobs', () => {
    const spans = jobSpans(data([job({ id: 'a' }), job({ id: 'b', drive_guid: 'other' })]), [d1])
    expect(spans).toEqual([{ id: 'a', start: T0, end: T0 + 10 * MIN, series: 'd1', color: 'var(--s1)' }])
  })

  it('orders spans by drive, then start, so each drive\'s jobs form one rail row', () => {
    const d2 = chartDrive('d2', makeDrive({ model: 'Ultrastar' }), { color: 'var(--s2)' })
    const spans = jobSpans(data([job({ id: 'late', start: T0 + 20 * MIN }), job({ id: 'other', drive_guid: 'd2' }), job({ id: 'early' })]), [d2, d1])
    expect(spans.map(s => `${s.series}:${s.id}`)).toEqual(['d2:other', 'd1:early', 'd1:late'])
  })

  it('lists a job for any bucket it touched, and running jobs to the end', () => {
    const d = data([job({ start: T0 + 7 * MIN, end: T0 + 8 * MIN }), job({ id: 'r', operation_name: 'Long Test', start: T0 + 30 * MIN, end: null })])
    const names = (t: number) => jobsDuring(d, [d1], t).map(j => `${j.name} · ${j.drive.label}`)
    expect(names(T0 + 5 * MIN)).toEqual(['Bad Block Scan · Exos X16 FF02'])   // inside the 12:05–12:10 bucket
    expect(names(T0 + 10 * MIN)).toEqual([])
    expect(names(T0 + 55 * MIN)).toEqual(['Long Test · Exos X16 FF02'])
  })
})

describe('bucketLabel', () => {
  it('gives the bucket as a span of clock time', () => {
    expect(bucketLabel(T0, 5 * MIN)).toMatch(/12:00–12:05$/)
  })
})

describe('roundTemp', () => {
  it('holds a whole-degree flip-flop at the half, and ignores a lone blip', () => {
    expect(roundTemp((31 + 31 + 30 + 31 + 30 + 30 + 31) / 7)).toBe(30.5)   // 30.57
    expect(roundTemp((30 * 59 + 31) / 60)).toBe(30)                       // 30.02
    expect(roundTemp((31 * 59 + 30) / 60)).toBe(31)
    expect(roundTemp(32.1)).toBe(32)
    expect(roundTemp(null)).toBeNull()
  })
})

describe('dataGaps', () => {
  const d1 = chartDrive('d1', makeDrive({}), style)
  const d2 = chartDrive('d2', makeDrive({}), { color: 'var(--s2)' })
  // 5-minute buckets over an hour; each drive's vitals at the given bucket indexes.
  const withVitals = (have: Record<string, number[]>) => ({
    ...data([]),
    drives: Object.fromEntries(Object.entries(have).map(([g, ks]) => [g, { vitals: { t: ks.map(k => T0 + k * 5 * MIN) } }])),
  } as unknown as DriveHistoryData)
  const at = (k0: number, k1: number) => ({ start: T0 + k0 * 5 * MIN, end: T0 + k1 * 5 * MIN })

  it('finds each drive\'s missing buckets, and where every drive is missing', () => {
    const g = dataGaps(withVitals({ d1: [0, 1, 4, 5, 6, 7, 8, 9], d2: [0, 1, 2, 5, 6, 7, 8, 9] }), [d1, d2])
    expect(g.bySeries.d1).toEqual([at(2, 4)])
    expect(g.bySeries.d2).toEqual([at(3, 5)])
    expect(g.all).toEqual([at(3, 4)])
  })

  it('counts a drive not seen yet as missing, but stops at the newest bucket any drive has', () => {
    const g = dataGaps(withVitals({ d1: [0, 1, 2, 3, 4, 5, 6, 7], d2: [3, 4, 5, 6, 7] }), [d1, d2])
    expect(g.bySeries.d2).toEqual([at(0, 3)])      // before it was first read
    expect(g.bySeries.d1).toEqual([])              // buckets 8–11: still rolling up, not missing
    expect(g.all).toEqual([])
  })

  it('ignores a drive one bucket behind at the edge, but not a drive that went away', () => {
    const g = dataGaps(withVitals({ d1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], d2: [0, 1, 2, 3, 4, 5, 6, 7, 8], d3: [0, 1, 2, 3, 4, 5, 6] }),
      [d1, d2, chartDrive('d3', makeDrive({}), style)])
    expect(g.bySeries.d2).toEqual([])
    expect(g.bySeries.d3).toEqual([at(7, 10)])
  })

  it('follows the readings, not the range start\'s bucket grid (off it after a DST change)', () => {
    const h = withVitals({ d1: [] })
    // Every reading 2 minutes off the grid; buckets 4 and 5 missing.
    h.drives.d1.vitals.t = [0, 1, 2, 3, 6, 7, 8, 9].map(k => T0 + k * 5 * MIN + 2 * MIN)
    expect(dataGaps(h, [d1]).bySeries.d1).toEqual([{ start: T0 + 22 * MIN, end: T0 + 32 * MIN }])
  })

  it('reads the whole range as missing when nothing has data', () => {
    expect(dataGaps(withVitals({ d1: [] }), [d1]).all).toEqual([at(0, 12)])
  })
})
