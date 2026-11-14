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
    await waitFor(() => expect(document.querySelectorAll('.tsc-span')).toHaveLength(3))   // one per chart: temperature, throughput, health
    fireEvent.click(screen.getByLabelText('Show jobs'))
    expect(document.querySelectorAll('.tsc-span')).toHaveLength(0)
  })

  // d1 (SATA-like) reports every counter; d2 (SAS-like) has no pending or CRC
  // counts; d3 reports nothing at all (a virtual disk).
  const withSignals = () => {
    const h = history()
    const at = (m: number) => `2026-11-13T12:0${m}:00`
    ;(h.thresholds as { signals: Record<string, unknown> }).signals = { ...h.thresholds.signals, reallocated: { warn_gte: 1, crit_gte: null }, uncorrected: { warn_gte: null, crit_gte: 1 }, load_unload_cycles: { warn_gte: 500000, crit_gte: 700000 } }
    Object.assign(h.drives.d1, {
      signals: {
        reallocated: [{ t: at(0), value: 0 }, { t: at(4), value: 3 }],
        pending: [{ t: at(0), value: 0 }], uncorrected: [{ t: at(0), value: 0 }], crc_errors: [{ t: at(0), value: 0 }],
        load_unload_cycles: [{ t: at(0), value: 2000 }, { t: at(6), value: 2001 }],
      },
      health: [{ t: at(0), health_pct: 95, health_status: 'Healthy' }, { t: at(4), health_pct: 80, health_status: 'Degraded' }],
    })
    Object.assign(h.drives.d2, {
      signals: { reallocated: [{ t: at(0), value: 6 }], uncorrected: [{ t: at(0), value: 2 }] },
      health: [{ t: at(0), health_pct: 70, health_status: 'Degraded' }],
    })
    ;(h.drives as Record<string, unknown>).d3 = { vitals: vitals([]), signals: {}, health: [{ t: at(0), health_pct: null, health_status: null }] }
    return h
  }
  const allDrives = [...drives, makeDrive({ guid: 'd3', model: 'QEMU HARDDISK', serial: null })]
  const card = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!

  it('charts health scores over the status bands, naming the biggest fall and drives never scored', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Health score over time')).toHaveLength(3))
    const health = card('Health score')
    expect(health).toHaveTextContent('Healthy ≥ 90 · Degraded 60–89 · Failing < 60')
    expect(health).toHaveTextContent(/Fell 95 → 80.*Exos X16/)
    expect(health.querySelector('.chart-card-foot')).toHaveTextContent(/^Not scored.*QEMU HARDDISK/)
    expect(health.querySelectorAll('.tsc-band')).toHaveLength(3)
  })

  it('charts a counter that moved, and names its change', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Reallocated sectors over time')).toHaveLength(2))
    expect(card('Reallocated sectors')).toHaveTextContent(/\+3.*Exos X16/)
    expect(screen.getByText('warning ≥ 1')).toBeInTheDocument()
    // Steady but not zero: still charted, saying nothing changed.
    expect(lines('Uncorrected errors over time')).toHaveLength(2)
    expect(card('Uncorrected errors')).toHaveTextContent('No change in this range')
  })

  it('names a threshold far above the data instead of stretching the chart to it', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Load/unload cycles over time')).toHaveLength(1))
    const cycles = card('Load/unload cycles')
    expect(cycles).toHaveTextContent('Running total · warning ≥ 500,000 · critical ≥ 700,000')
    expect(cycles.querySelector('.tsc-threshold')).toBeNull()
    expect(cycles).toHaveTextContent(/\+1.*Exos X16/)
  })

  it('shrinks a counter that is 0 throughout to a line, naming drives without it (but not ones with no SMART at all)', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Pending sectors' })).toBeInTheDocument())
    const pending = card('Pending sectors')
    expect(pending).toHaveTextContent('0 throughout')
    expect(pending.querySelector('svg.tsc-svg')).toBeNull()
    expect(pending.querySelector('.chart-card-foot')).toHaveTextContent(/^Not reported by.*Ultrastar/)
    expect(pending.querySelector('.chart-card-foot')).not.toHaveTextContent('QEMU')
  })

  it('leaves out a counter no charted drive reports', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d2', 'd3']} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reallocated sectors' })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Pending sectors' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'CRC errors' })).toBeNull()
  })

  it('brings a drive forward in every chart while its legend chip has focus', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    const chip = screen.getAllByRole('button', { pressed: true })[1]   // d2
    fireEvent.focus(chip)
    expect(document.querySelectorAll('[aria-label="Temperature over time"] .tsc-line.dim')).toHaveLength(1)
    expect(document.querySelectorAll('[aria-label="Disk throughput over time"] .tsc-line.dim')).toHaveLength(1)
    fireEvent.blur(chip)
    expect(document.querySelectorAll('.tsc-line.dim')).toHaveLength(0)
  })
})
