import { describe, expect, it } from 'vitest'
import { bucketLabel, chartDrive, jobsDuring, jobSpans, roundTemp } from './historySeries'
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
    expect(spans).toEqual([{ id: 'a', start: T0, end: T0 + 10 * MIN, label: 'Bad Block Scan' }])
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
