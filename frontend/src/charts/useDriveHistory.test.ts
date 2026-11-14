import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshMs, useDriveHistory } from './useDriveHistory'
import type { HistoryRange } from './useDriveHistory'
import { fetchJsonResponse } from '../test/fixtures'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

const raw = (range = '24h', guids = ['d1']) => ({
  range,
  start: '2026-11-12T13:00:00',
  end: '2026-11-13T13:02:11.5',
  bucket_seconds: 300,
  thresholds: { signals: { temp: { warn_gte: 45, crit_gte: null } }, health: { healthy_gte: 90, degraded_gte: 60 } },
  drives: Object.fromEntries(guids.map(g => [g, {
    vitals: { t: ['2026-11-12T13:00:00'], temp_avg: [31.5], temp_min: [31], temp_max: [32], read_bps: [0], write_bps: [0], busy_pct: [0] },
    signals: { pending: [{ t: '2026-11-12T13:00:00', value: 0 }] },
    health: [{ t: '2026-11-12T13:00:00', health_pct: 100, health_status: 'healthy' }],
  }])),
  jobs: [{ id: 'j1', drive_guid: 'd1', operation: 'badblocks', operation_name: 'Badblocks', category: 'Surface',
    status: 'running', summary: null, error: null, started_at: '2026-11-13T09:00:00', finished_at: null }],
})
const local = (iso: string) => new Date(iso).getTime()

describe('useDriveHistory', () => {
  it('fetches the drives and range, and parses every time to ms', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(raw()))
    const { result } = renderHook(() => useDriveHistory(['d1', 'd2'], '24h'))
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/drives/history?guids=d1%2Cd2&range=24h')
    await waitFor(() => expect(result.current.data).not.toBeNull())
    const data = result.current.data!
    expect(data.start).toBe(local('2026-11-12T13:00:00'))
    expect(data.bucketMs).toBe(300_000)
    expect(data.drives.d1.vitals.t).toEqual([local('2026-11-12T13:00:00')])
    expect(data.drives.d1.vitals.temp_avg).toEqual([31.5])
    expect(data.drives.d1.health[0]).toEqual({ t: local('2026-11-12T13:00:00'), pct: 100, status: 'healthy' })
    expect(data.jobs[0]).toMatchObject({ start: local('2026-11-13T09:00:00'), end: null })
    expect(result.current.stale).toBe(false)
  })

  it('keeps the previous answer, marked stale, while a new range loads', async () => {
    let resolve24: (r: Response) => void = () => {}
    vi.mocked(fetch)
      .mockResolvedValueOnce(fetchJsonResponse(raw('1h')))
      .mockReturnValueOnce(new Promise(r => { resolve24 = r }))
    const { result, rerender } = renderHook(({ range }: { range: HistoryRange }) => useDriveHistory(['d1'], range), { initialProps: { range: '1h' } })
    await waitFor(() => expect(result.current.data?.range).toBe('1h'))
    rerender({ range: '24h' })
    expect(result.current.data?.range).toBe('1h')
    expect(result.current.stale).toBe(true)
    resolve24(fetchJsonResponse(raw('24h')))
    await waitFor(() => expect(result.current.stale).toBe(false))
    expect(result.current.data?.range).toBe('24h')
  })

  it('reports the server error, without data from another request', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse({ error: "'guids' must list at least one drive" }, 400))
    const { result } = renderHook(() => useDriveHistory(['d1'], '24h'))
    await waitFor(() => expect(result.current.error).toMatch(/guids/))
    expect(result.current.data).toBeNull()
  })

  it('fetches nothing with no drives', () => {
    const { result } = renderHook(() => useDriveHistory([], '24h'))
    expect(fetch).not.toHaveBeenCalled()
    expect(result.current.data).toBeNull()
  })

  it('refreshes about once a bucket, between one and five minutes', () => {
    expect(refreshMs('1h')).toBe(60e3)
    expect(refreshMs('24h')).toBe(300e3)
    expect(refreshMs('90d')).toBe(300e3)
  })
})
