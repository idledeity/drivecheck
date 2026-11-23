import { act, fireEvent, render, screen } from '@testing-library/react'
import { useContext, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TrendsJobs from './TrendsJobs'
import ChartHoverSync from './ChartHoverSync'
import { ChartHoverContext } from './chartHover'
import { chartDrive } from './historySeries'
import type { DriveHistoryData, HistoryJob } from './useDriveHistory'
import { makeDrive } from '../test/fixtures'

const MIN = 60e3
const T0 = new Date(2026, 10, 13, 12, 0).getTime()
const d1 = chartDrive('d1', makeDrive({ model: 'Exos X16', serial: 'ZTM0FF02' }), { color: 'var(--s1)' })
const d2 = chartDrive('d2', makeDrive({ model: 'Ultrastar', serial: '1EJ6JG4J' }), { color: 'var(--s2)' })

const job = (o: Partial<HistoryJob>): HistoryJob => ({
  id: 'j', drive_guid: 'd1', operation: 'badblocks', operation_name: 'Bad Block Scan', category: 'Surface',
  status: 'completed', summary: null, error: null, started_at: '', finished_at: null, start: T0, end: T0 + 2 * MIN, ...o,
})
const data = {
  start: T0, end: T0 + 60 * MIN, bucketMs: 5 * MIN,
  jobs: [
    job({ id: 'b', drive_guid: 'd2', operation_name: 'Sleep (debug)', status: 'failed', start: T0 + MIN }),
    job({ id: 'a' }),
    job({ id: 'c', operation_name: 'Long Test', start: T0 + 30 * MIN, end: null }),
  ],
} as unknown as DriveHistoryData

// Sets the group's hovered time from a test.
let hoverAt: (t: number) => void = () => {}
function Hover() {
  const h = useContext(ChartHoverContext)!
  useEffect(() => { hoverAt = t => h.setHover({ t, source: 'test' }) }, [h])
  return null
}
const strip = () => render(<ChartHoverSync readingsBelow><Hover /><TrendsJobs data={data} drives={[d1, d2]} /></ChartHoverSync>)

const media = (desktop: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: desktop, media: q, addEventListener() {}, removeEventListener() {} }))

describe('TrendsJobs', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('on a desktop, folds the jobs at the hovered time open in place, by drive, with when and how they ended', () => {
    media(true)
    strip()
    act(() => hoverAt(T0))
    expect(screen.getByRole('button', { name: /2 jobs/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /2 jobs/ }))
    const rows = screen.getAllByRole('listitem').map(r => r.textContent)
    expect(rows[0]).toMatch(/^Bad Block Scan.*Exos X16.*12:00–12:02$/)          // legend order, not start order
    expect(rows[1]).toMatch(/^Sleep \(debug\).*Ultrastar.*12:01–12:02 · failed$/)
    expect(localStorage.getItem('trends.jobsOpen')).toBe('1')

    act(() => hoverAt(T0 + 10 * MIN))                                           // open stays open, with nothing to list
    expect(screen.getByText('No jobs running at this time')).toBeInTheDocument()
    act(() => hoverAt(T0 + 30 * MIN))
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(/Long Test.*12:30–now/)
  })

  it('folded, shows a lone job on the line itself', () => {
    media(true)
    strip()
    act(() => hoverAt(T0 + 30 * MIN))
    expect(screen.getByRole('button', { name: /1 job/ })).toBeInTheDocument()
    expect(screen.getByText('Long Test')).toBeInTheDocument()
  })

  it('on touch, keeps to one line, several jobs behind a popover', () => {
    media(false)
    strip()
    act(() => hoverAt(T0))
    expect(screen.getByRole('button', { name: /2 jobs/ })).not.toHaveAttribute('aria-expanded')
    expect(screen.queryByText('Bad Block Scan')).toBeNull()
  })
})
