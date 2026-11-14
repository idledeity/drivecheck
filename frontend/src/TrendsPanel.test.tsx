import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TrendsPanel from './TrendsPanel'
import { fetchJsonResponse, makeDrive } from './test/fixtures'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

const vitals = (temps: number[], bps = 0) => ({
  t: temps.map((_, i) => `2026-11-13T12:0${i}:00`),
  temp_avg: temps, temp_min: temps, temp_max: temps.map(t => t + 1),
  read_bps: temps.map(() => bps), write_bps: temps.map(() => 0), busy_pct: temps.map(() => 0),
})
const history = (range = '24h') => ({
  range,
  start: '2026-11-13T12:00:00',
  end: '2026-11-13T12:10:00',
  bucket_seconds: 60,
  thresholds: { signals: { temp: { warn_gte: 45, crit_gte: null } }, health: { healthy_gte: 90, degraded_gte: 60 } },
  drives: {
    d1: { vitals: vitals([30, 31, 32], 200e6), signals: {}, health: [] },
    d2: { vitals: vitals([40, 41, 47]), signals: {}, health: [] },
  },
  jobs: [{ id: 'j1', drive_guid: 'd1', operation: 'badblocks', operation_name: 'Bad Block Scan', category: 'Surface',
    status: 'running', summary: null, error: null, started_at: '2026-11-13T12:01:00', finished_at: null }],
})
const drives = [
  makeDrive({ guid: 'd1', model: 'Exos X16', serial: 'ZTM0FF02' }),
  makeDrive({ guid: 'd2', model: 'Ultrastar', serial: '1EJ6JG4J' }),
]
const renderPanel = (selectedGuids = ['d1', 'd2']) => render(<TrendsPanel drives={drives} selectedGuids={selectedGuids} />)
const lines = (chart: string) => document.querySelectorAll(`[aria-label="${chart}"] .tsc-line`)

describe('TrendsPanel', () => {
  it('asks for a selection when no drives are selected, and fetches nothing', () => {
    renderPanel([])
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('charts temperature and throughput for every selected drive, with headline callouts', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    expect(fetch).toHaveBeenCalledWith('/api/drives/history?guids=d1%2Cd2&range=24h', expect.anything())
    expect(lines('Disk throughput over time')).toHaveLength(2)
    expect(screen.getByText('48 °C')).toBeInTheDocument()            // hottest bucket max: d2's 47 + 1
    expect(screen.getByText(/Ultrastar JG4J · /)).toBeInTheDocument()
    expect(screen.getByText('200.0 MB/s')).toBeInTheDocument()       // peak throughput
    expect(screen.getByText('45 °C warning')).toBeInTheDocument()
  })

  it('reads temperature as the bucket average to the half degree, without its range', async () => {
    const h = history()
    h.drives.d1.vitals = { ...vitals([30.57, 30.6, 31, 32]), temp_min: [30, 29, 31, 31], temp_max: [31, 32, 31, 33] }
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(h))
    renderPanel(['d1'])
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(1))
    const svg = screen.getByRole('img', { name: 'Temperature over time' })
    fireEvent.focus(svg)                                               // newest bucket
    const value = () => screen.getByRole('status').querySelector('.tsc-tip-value')
    expect(value()).toHaveTextContent(/^32\.0 °C$/)
    fireEvent.keyDown(svg, { key: 'ArrowLeft' })
    fireEvent.keyDown(svg, { key: 'ArrowLeft' })
    expect(value()).toHaveTextContent(/^30\.5 °C$/)    // 30.6 → nearest .5; no (29–32)
  })

  it('colors a drive by its place among all drives, whatever is selected', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel(['d2'])                                                // d2 alone is still the second drive
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(1))
    expect(lines('Temperature over time')[0]).toHaveAttribute('stroke', 'var(--s2)')
  })

  it('hides a drive from every chart with its chip, but never the last one shown', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    const chip = (name: RegExp) => screen.getByRole('button', { name })
    fireEvent.click(chip(/Ultrastar/))
    expect(chip(/Ultrastar/)).toHaveAttribute('aria-pressed', 'false')
    expect(lines('Temperature over time')).toHaveLength(1)
    expect(lines('Disk throughput over time')).toHaveLength(1)
    fireEvent.click(chip(/Exos X16/))                            // the only one left: stays on
    expect(chip(/Exos X16/)).toHaveAttribute('aria-pressed', 'true')
    expect(fetch).toHaveBeenCalledTimes(1)                            // toggling never refetches
  })

  it('refetches for a new range, dimming the old charts until it arrives', async () => {
    let resolve7d: (r: Response) => void = () => {}
    vi.mocked(fetch)
      .mockResolvedValueOnce(fetchJsonResponse(history()))
      .mockReturnValueOnce(new Promise(r => { resolve7d = r }))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/drives/history?guids=d1%2Cd2&range=7d')
    expect(document.querySelector('.chart-card.stale')).not.toBeNull()
    resolve7d(fetchJsonResponse(history('7d')))
    await waitFor(() => expect(document.querySelector('.chart-card.stale')).toBeNull())
  })

  it('shades jobs only while Show jobs is on', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(document.querySelectorAll('.tsc-span')).toHaveLength(2))   // one per chart
    fireEvent.click(screen.getByLabelText('Show jobs'))
    expect(document.querySelectorAll('.tsc-span')).toHaveLength(0)
  })
})
