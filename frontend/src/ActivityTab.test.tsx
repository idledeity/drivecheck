import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ActivityTab from './ActivityTab'
import { fetchJsonResponse, makeDrive, makeJob } from './test/fixtures'
import type { Job } from './types'

// /api/config gives jobs.max_parallel; /api/jobs/history gives stored finished jobs.
let stored: Job[] = []
let maxParallel: number | null = 2
beforeEach(() => {
  stored = []
  maxParallel = 2
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 11, 19, 30))
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(fetchJsonResponse(
    url === '/api/config' ? [{ key: 'jobs.max_parallel', value: maxParallel }] : stored,
  ))))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const drives = [
  makeDrive({ guid: 'd1', model: 'Exos One', serial: 'AAAA0001' }),
  makeDrive({ guid: 'd2', model: 'Exos Two', serial: 'BBBB0002' }),
  makeDrive({ guid: 'd3', model: 'Ultrastar', serial: 'CCCC0003' }),
]
const running = (id: string, guid: string, eta: number | null = 600) =>
  makeJob({ id, drive_guid: guid, status: 'running', started_at: '2026-11-11T18:00:00', operation_name: `Run ${id}`, progress: { percent: 50, message: null, eta_seconds: eta } })
const queued = (id: string, guid: string, pos: number) =>
  makeJob({ id, drive_guid: guid, status: 'queued', queue_position: pos, operation_name: `Queued ${id}` })

function renderTab(props: Partial<React.ComponentProps<typeof ActivityTab>> = {}) {
  const handlers = { onCancel: vi.fn(), onMove: vi.fn(), onMarkSeen: vi.fn(), onShowHistory: vi.fn() }
  render(<ActivityTab drives={drives} selectedGuids={[]} jobs={[]} unseen={[]} {...handlers} {...props} />)
  return handlers
}
const lane = (name: RegExp) => screen.getByRole('region', { name })

describe('ActivityTab', () => {
  it('summarizes running and queued jobs against the parallel limit', async () => {
    renderTab({ jobs: [running('a', 'd1', 4000), running('b', 'd2', 900), queued('q', 'd3', 0)] })
    const summary = screen.getByRole('region', { name: 'Summary' })
    await waitFor(() => expect(within(summary).getByText('of 2 slots')).toBeInTheDocument())
    expect(within(summary).getByText('1 drive waiting for a slot')).toBeInTheDocument()
    expect(within(summary).getByText('~15m 0s')).toBeInTheDocument()   // the shorter ETA
    expect(within(summary).getByText('Run b · Exos Two 0002')).toBeInTheDocument()
  })

  it('shows one lane per busy drive with its queue in run order', () => {
    renderTab({ jobs: [running('a', 'd1'), queued('second', 'd1', 1), queued('first', 'd1', 0)] })
    const items = within(lane(/Exos One/)).getAllByRole('listitem').map(li => li.textContent)
    expect(items[0]).toMatch(/^1Queued first/)
    expect(items[1]).toMatch(/^2Queued second/)
    expect(screen.queryByRole('region', { name: /Exos Two/ })).not.toBeInTheDocument()
    expect(screen.getByText('2 idle drives hidden')).toBeInTheDocument()
  })

  it('moves and cancels queued jobs, with the ends disabled', () => {
    const h = renderTab({ jobs: [running('a', 'd1'), queued('first', 'd1', 0), queued('second', 'd1', 1)] })
    expect(screen.getByRole('button', { name: 'Move up: Queued first' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move down: Queued second' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Move up: Queued second' }))
    expect(h.onMove).toHaveBeenCalledWith('second', 'up')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel: Queued first' }))
    expect(h.onCancel).toHaveBeenCalledWith('first')
  })

  it('explains a queued job only when its drive is free but every slot is taken', async () => {
    renderTab({ jobs: [running('a', 'd1'), running('b', 'd2'), queued('behind', 'd1', 0), queued('blocked', 'd3', 1)] })
    await waitFor(() => expect(screen.getByText('Waits for a free slot (2 of 2 running)')).toBeInTheDocument())
    expect(within(lane(/Ultrastar/)).getByText('Waiting for a slot')).toBeInTheDocument()
    expect(within(lane(/Exos One/)).queryByText(/Waits for/)).not.toBeInTheDocument()
  })

  it('lists new results with Mark seen', () => {
    const result = makeJob({ id: 'r', drive_guid: 'd3', status: 'failed', error: 'read element failure', finished_at: '2026-11-11T18:40:00', operation_name: 'Short Test' })
    const h = renderTab({ unseen: [result] })
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('New since you last looked (1)')).toBeInTheDocument()
    expect(within(summary).getByText('read element failure')).toBeInTheDocument()
    fireEvent.click(within(summary).getByRole('button', { name: 'Mark seen' }))
    expect(h.onMarkSeen).toHaveBeenCalled()
  })

  it('says when there is nothing new', () => {
    renderTab()
    expect(screen.getByText('Nothing new since you last looked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark seen' })).not.toBeInTheDocument()
  })

  it('keeps recently finished jobs in their lane for the chosen window', async () => {
    stored = [makeJob({ id: 'f', drive_guid: 'd2', status: 'completed', finished_at: '2026-11-11T12:00:00', operation_name: 'Old Read' })]
    renderTab()
    await waitFor(() => expect(within(lane(/Exos Two/)).getByText('Old Read')).toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/jobs\/history\?limit=500&since=2026-11-0[89]T/))
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(screen.queryByRole('region', { name: /Exos Two/ })).not.toBeInTheDocument()
  })

  it('keeps only the newest result per drive for Last only', async () => {
    stored = [
      makeJob({ id: 'new', drive_guid: 'd2', status: 'completed', finished_at: '2026-07-01T12:00:00', operation_name: 'Newer' }),
      makeJob({ id: 'old', drive_guid: 'd2', status: 'failed', finished_at: '2026-06-01T12:00:00', operation_name: 'Older' }),
    ]
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Last only' }))
    await waitFor(() => expect(within(lane(/Exos Two/)).getByText('Newer')).toBeInTheDocument())
    expect(within(lane(/Exos Two/)).queryByText('Older')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenLastCalledWith('/api/jobs/history?limit=500')
  })

  it('filters to selected drives and counts busy lanes it hides', () => {
    renderTab({ jobs: [running('a', 'd1'), running('b', 'd2')], selectedGuids: ['d2'] })
    fireEvent.click(screen.getByRole('button', { name: 'Selected (1)' }))
    expect(screen.queryByRole('region', { name: /Exos One/ })).not.toBeInTheDocument()
    expect(lane(/Exos Two/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(lane(/Exos One/)).toBeInTheDocument()
  })

  it('gives a job on a drive that dropped out its own lane', () => {
    renderTab({ jobs: [running('ghost', 'gone-guid')] })
    expect(within(lane(/Unknown drive/)).getByText('Run ghost')).toBeInTheDocument()
  })

  it('reports no parallel limit when the config has none', async () => {
    maxParallel = null
    renderTab({ jobs: [running('a', 'd1')] })
    await waitFor(() => expect(screen.getByText('no parallel limit')).toBeInTheDocument())
  })
})
