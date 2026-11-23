import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TrendsPanel from './TrendsPanel'
import { trendsCounterViews } from './charts/counters'
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
  thresholds: { signals: { temp: { warn_gte: 45, crit_gte: null } }, health: { healthy_gte: 95, aging_gte: 80, degraded_gte: 40, failing_gte: 15 } },
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
const card = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!
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
    const chip = (name: RegExp) => within(screen.getByRole('group', { name: 'Drives shown' })).getByRole('button', { name })
    fireEvent.click(chip(/Ultrastar/))
    expect(chip(/Ultrastar/)).toHaveAttribute('aria-pressed', 'false')
    expect(lines('Temperature over time')).toHaveLength(1)
    expect(lines('Disk throughput over time')).toHaveLength(1)
    fireEvent.click(chip(/Exos X16/))                            // the only one left: stays on
    expect(chip(/Exos X16/)).toHaveAttribute('aria-pressed', 'true')
    expect(fetch).toHaveBeenCalledTimes(1)                            // toggling never refetches
  })

  it('highlights a drive in every chart from a readings row: another row moves it, the same row clears it', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    const tempLines = () => [...lines('Temperature over time')]
    const dimmed = (els: Element[]) => els.map(e => e.classList.contains('dim'))
    const row = (name: RegExp) => within(card('Temperature')).getByRole('button', { name })
    expect(dimmed(tempLines())).toEqual([false, false])

    fireEvent.click(row(/Ultrastar/))
    expect(row(/Ultrastar/)).toHaveAttribute('aria-pressed', 'true')
    // d2's line comes last (drawn on top) and stays bright; d1's dims, in this chart and the others.
    expect(tempLines().map(l => l.getAttribute('stroke'))).toEqual(['var(--s1)', 'var(--s2)'])
    expect(dimmed(tempLines())).toEqual([true, false])
    expect(dimmed([...lines('Disk throughput over time')])).toEqual([true, false])
    expect(row(/Exos X16/)).toHaveClass('dim')
    expect(row(/Ultrastar/)).not.toHaveClass('dim')

    fireEvent.click(row(/Exos X16/))                                    // switches: d1 now on top
    expect(tempLines().map(l => l.getAttribute('stroke'))).toEqual(['var(--s2)', 'var(--s1)'])
    expect(dimmed(tempLines())).toEqual([true, false])
    expect(row(/Ultrastar/)).toHaveAttribute('aria-pressed', 'false')

    fireEvent.keyDown(row(/Exos X16/), { key: 'Enter' })               // the same row again: clears
    expect(dimmed(tempLines())).toEqual([false, false])
    expect(row(/Exos X16/)).not.toHaveClass('dim')
  })

  it('previews a drive while the mouse is over its readings row, unless one is picked', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    const dimmedStrokes = () => [...lines('Temperature over time')].filter(l => l.classList.contains('dim')).map(l => l.getAttribute('stroke'))
    const row = (name: RegExp) => within(card('Temperature')).getByRole('button', { name })
    fireEvent.pointerEnter(row(/Ultrastar/), { pointerType: 'touch' })        // a tap isn't a hover
    expect(dimmedStrokes()).toEqual([])
    fireEvent.pointerEnter(row(/Ultrastar/), { pointerType: 'mouse' })
    expect(dimmedStrokes()).toEqual(['var(--s1)'])
    expect(row(/Ultrastar/)).toHaveAttribute('aria-pressed', 'false')          // previewed, not picked
    fireEvent.pointerLeave(row(/Ultrastar/), { pointerType: 'mouse' })
    await waitFor(() => expect(dimmedStrokes()).toEqual([]))                    // a moment after leaving

    fireEvent.click(row(/Exos X16/))                                            // picked: hovering others changes nothing
    fireEvent.pointerEnter(row(/Ultrastar/), { pointerType: 'mouse' })
    expect(dimmedStrokes()).toEqual(['var(--s2)'])
  })

  it('drops the highlight when the highlighted drive is hidden', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(history()))
    renderPanel()
    await waitFor(() => expect(lines('Temperature over time')).toHaveLength(2))
    fireEvent.click(within(card('Temperature')).getByRole('button', { name: /Ultrastar/ }))
    const chip = within(screen.getByRole('group', { name: 'Drives shown' })).getByRole('button', { name: /Ultrastar/ })
    fireEvent.click(chip)                                                // hide
    fireEvent.click(chip)                                                // and show again
    expect([...lines('Temperature over time')].some(l => l.classList.contains('dim'))).toBe(false)
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
  // A card's reading rows at its newest point (focusing a chart starts there).
  const readingsAtNewest = (title: string) => {
    fireEvent.focus(within(card(title)).getByRole('img'))
    return [...card(title).querySelectorAll('.tsc-tip-row')].map(r => r.textContent)
  }

  it('charts health scores over the status bands, counting falls in the header and naming drives never scored', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Health score over time')).toHaveLength(2))   // the never-scored drive gets a row, not a line
    const health = card('Health score')
    expect(health).toHaveTextContent('Healthy ≥ 95 · Aging 80–94 · Degraded 40–79 · Failing 15–39 · Critical < 15')
    expect(health.querySelector('.chart-card-callout')).toHaveTextContent('1 of 2 drives fell')
    expect(health.querySelector('.hcl-list')).toHaveTextContent(/Exos X16.*95 → 80/)
    expect([...health.querySelectorAll('.tsc-tip-row.absent')].map(r => r.textContent)).toEqual([expect.stringMatching(/QEMU HARDDISK.*not scored$/)])
    expect(health.querySelectorAll('.tsc-band')).toHaveLength(5)
  })

  it('charts a counter that moved, with its change since the range start beside the count', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Reallocated sectors over time')).toHaveLength(2))
    expect(card('Reallocated sectors')).toHaveTextContent('1 of 2 drives changed')
    expect(readingsAtNewest('Reallocated sectors')).toContainEqual(expect.stringMatching(/Exos X16.*3\+3$/))
    expect(screen.getByText('warning ≥ 1')).toBeInTheDocument()
    // Steady but not zero: still charted, saying nothing changed.
    expect(lines('Uncorrected errors over time')).toHaveLength(2)
    expect(card('Uncorrected errors')).toHaveTextContent('No change in this range')
  })

  it('logs score changes under the health chart, telling a first reading apart from a change', async () => {
    const h = history()
    const at = (m: number) => `2026-11-13T12:0${m}:00`
    const f = (signal: string, label: string, value: string, role: string, points: number) =>
      ({ key: `curve:${signal}`, kind: 'media', label, signal, value, standalone: role === 'start' ? points : 70, weight: 1, role, points })
    Object.assign(h.drives.d2, {
      signals: { uncorrected: [{ t: at(0), value: 7 }], pending: [{ t: at(4), value: 108 }], link_errors: [{ t: at(4), value: 57 }] },
      health: [
        { t: at(0), health_pct: 35, health_status: 'Failing', factors: [f('uncorrected', 'Uncorrected errors', '7', 'start', 39)], floor: null },
        { t: at(4), health_pct: 20, health_status: 'Failing', factors: [f('pending', 'Pending sectors', '108', 'start', 27.6), f('uncorrected', 'Uncorrected errors', '7', 'adds', -5.9)], floor: null },
      ],
      first_readings: { uncorrected: '2026-11-01T00:00:00', pending: at(4), link_errors: at(4) },
    })
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(h))
    renderPanel(['d2'])
    await waitFor(() => expect(lines('Health score over time')).toHaveLength(1))
    const health = card('Health score')
    const entries = within(health).getAllByRole('listitem')
    expect(entries).toHaveLength(1)                       // the score carried in isn't a change
    expect(entries[0]).toHaveTextContent(/35 → 20Failing.*Pending sectors 108 now sets the score.*first reading/)
    expect(health.querySelectorAll('.tsc-marker')).toHaveLength(1)

    // As of then: the factors, the one that set it before, and what else was first read.
    const button = within(entries[0]).getByRole('button')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const rows = within(entries[0]).getAllByRole('row').map(r => r.textContent)
    expect(rows).toEqual([
      'FactorValueOn its ownRolePoints',
      'Pending sectors108◇ first28sets the score28',
      'Uncorrected errors770lowers it (set it before)−5.9',
      'Link errors57◇ first—not scored',
    ])

    // The counter first read in the range says so, rather than "no change".
    expect(card('Pending sectors')).toHaveTextContent('First read in this range · no change since')
    expect(card('Pending sectors').querySelectorAll('.tsc-marker')).toHaveLength(1)
  })

  it('names a threshold far above the data instead of stretching the chart to it', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Load/unload cycles over time')).toHaveLength(1))
    const cycles = card('Load/unload cycles')
    expect(cycles).toHaveTextContent('Running total · warning ≥ 500,000 · critical ≥ 700,000')
    expect(cycles.querySelector('.tsc-threshold')).toBeNull()
    expect(readingsAtNewest('Load/unload cycles')).toContainEqual(expect.stringMatching(/Exos X16.*2,001\+1$/))
  })

  it('charts a counter that is 0 throughout in full, with a "not reported" reading for each drive without it', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Pending sectors over time')).toHaveLength(1))
    const pending = card('Pending sectors')
    expect(pending).toHaveTextContent('No change in this range')
    const absent = [...pending.querySelectorAll('.tsc-tip-row.absent')].map(r => r.textContent)
    expect(absent).toEqual([expect.stringMatching(/Ultrastar.*not reported$/), expect.stringMatching(/QEMU.*not reported$/)])
    expect(pending.querySelector('.chart-card-foot')).toBeNull()
  })

  it('switches a counter to its Events view: a lane per drive with its status line', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Reallocated sectors over time')).toHaveLength(2))
    const realloc = card('Reallocated sectors')
    fireEvent.click(within(realloc).getByRole('button', { name: 'Events' }))
    const lanes = within(realloc).getByRole('group', { name: /Reallocated sectors, changes per drive/ })
    expect(lanes.querySelectorAll('.clc-lane')).toHaveLength(2)
    expect(lanes.querySelectorAll('.clc-mark')).toHaveLength(1)                 // d1: 0 → 3
    expect(lanes).toHaveTextContent(/3 · \+3 in last 4h/)                       // 24h range: Auto is 4h
    expect(lanes).toHaveTextContent(/6 · unchanged in range/)
    expect(realloc).toHaveTextContent('Each change, sized by its jump · shaded: last 4h')
    expect(within(realloc).getByLabelText('Show total')).not.toBeChecked()
  })

  it('picks each counter card\'s recent window in its own subtitle, not the filter row', async () => {
    trendsCounterViews.clear()
    const h = { ...withSignals(), start: '2026-11-12T12:10:00' }              // a full 24h, so shorter windows fit
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(h))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Reallocated sectors over time')).toHaveLength(2))
    expect(screen.queryByLabelText('Recent window')).toBeNull()                 // Total view: nothing to pick
    const realloc = card('Reallocated sectors')
    fireEvent.click(within(realloc).getByRole('button', { name: 'Events' }))
    const recent = within(realloc).getByLabelText('Recent window')
    expect(recent).toHaveValue('auto')
    expect(within(realloc).queryByLabelText('Compare with')).toBeNull()         // only Rate compares
    fireEvent.change(recent, { target: { value: '1h' } })                       // d1's change at 12:04 is still in it
    expect(realloc).toHaveTextContent(/3 · \+3 in last 1h/)
    expect(screen.getAllByLabelText('Recent window')).toHaveLength(1)           // the other cards keep theirs
    const cycles = card('Load/unload cycles')
    fireEvent.click(within(cycles).getByRole('button', { name: 'Rate' }))
    expect(within(cycles).getByLabelText('Recent window')).toHaveValue('auto')
    expect(within(cycles).getByLabelText('Compare with')).toHaveValue('rest')
  })

  it('in Events, steps between changes with the arrow keys and says when each was, and during what job', async () => {
    trendsCounterViews.clear()
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Reallocated sectors over time')).toHaveLength(2))
    const realloc = card('Reallocated sectors')
    fireEvent.click(within(realloc).getByRole('button', { name: 'Events' }))
    const lanes = within(realloc).getByRole('group', { name: /changes per drive/ })
    fireEvent.focus(lanes)
    fireEvent.keyDown(lanes, { key: 'ArrowLeft' })                              // straight to the one change
    const d1Row = () => [...realloc.querySelectorAll('.tsc-tip-row')].find(r => /Exos/.test(r.textContent ?? ''))!
    expect(d1Row()).toHaveTextContent(/3 \(\+3\)at 12:04 · Bad Block Scan/)
    fireEvent.keyDown(lanes, { key: 'ArrowLeft' })                              // none earlier: stays
    expect(d1Row()).toHaveTextContent(/at 12:04/)
  })

  it('lists an Events card\'s changes under it, collapsed, and a row pins its time', async () => {
    trendsCounterViews.clear()
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Reallocated sectors over time')).toHaveLength(2))
    const realloc = card('Reallocated sectors')
    expect(within(realloc).queryByRole('button', { name: /change in range/ })).toBeNull()   // Total view: no list
    fireEvent.click(within(realloc).getByRole('button', { name: 'Events' }))
    const toggle = within(realloc).getByRole('button', { name: /1 change in range/ })
    expect(within(realloc).queryByRole('list', { name: 'Changes in range' })).toBeNull()
    fireEvent.click(toggle)
    const list = within(realloc).getByRole('list', { name: 'Changes in range' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent(/12:04.*Exos.*\+3 → 3.*Bad Block Scan/)
    fireEvent.click(within(rows[0]).getByRole('button'))
    expect(screen.getByText(/Pinned .*12:04/)).toBeInTheDocument()
  })

  it('switches a wear counter to its Rate view, with bars and a rate status', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(withSignals()))
    render(<TrendsPanel drives={allDrives} selectedGuids={['d1', 'd2', 'd3']} />)
    await waitFor(() => expect(lines('Load/unload cycles over time')).toHaveLength(1))
    const cycles = card('Load/unload cycles')
    fireEvent.click(within(cycles).getByRole('button', { name: 'Rate' }))
    const lanes = within(cycles).getByRole('group', { name: /rate per drive/ })
    expect(lanes.querySelectorAll('.clc-bar')).toHaveLength(1)
    expect(lanes).toHaveTextContent(/\/day/)
    fireEvent.focus(lanes)                                                      // keyboard: a reading straight away
    expect(within(cycles).getByRole('status')).toBeInTheDocument()
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
