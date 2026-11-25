import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ActivityTab from './ActivityTab'
import ConfirmProvider from './ConfirmProvider'
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
  const handlers = { onCancel: vi.fn(), onMove: vi.fn(), onCancelBatch: vi.fn(), onMoveBatch: vi.fn(), onMarkSeen: vi.fn(), onShowHistory: vi.fn() }
  render(<ConfirmProvider><ActivityTab drives={drives} selectedGuids={[]} jobs={[]} unseen={[]} {...handlers} {...props} /></ConfirmProvider>)
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
    const queue = lane(/Exos One/).querySelector('.act-queue')!
    const rows = [...queue.querySelectorAll(':scope > .queue-row')].map(r => r.textContent)
    expect(rows[0]).toMatch(/^1.*Queued first/)
    expect(rows[1]).toMatch(/^2.*Queued second/)
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

  describe('batches', () => {
    const batch = (id: string, step: number, stopOnFailure = true) =>
      ({ id, step, recipe: 'initial_scan', recipe_name: `Recipe ${id}`, params: {}, stop_on_failure: stopOnFailure, smart: null })
    const step = (job: Job, id: string, n: number): Job => ({ ...job, batch: batch(id, n) })
    const box = (id: string) => screen.getByRole('group', { name: `Batch: Recipe ${id}` })
    const header = (id: string) => box(id).querySelector(':scope > .queue-row-main')!

    it('shows a queued batch as one task row that moves and cancels as a whole', async () => {
      const h = renderTab({ jobs: [
        running('a', 'd1'),
        step(queued('s0', 'd1', 0), 'b1', 0), step(queued('s1', 'd1', 1), 'b1', 1),
        queued('solo', 'd1', 2),
      ] })
      expect(header('b1').textContent).toMatch(/^1.*Exos One.*Recipe b12 steps.*Stops on failure/)
      expect(within(box('b1')).getByText('Queued s0')).toBeInTheDocument()
      // Steps move only with their batch.
      expect(screen.queryByRole('button', { name: 'Move up: Queued s0' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Move up: Recipe b1' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Move down: Recipe b1' }))
      expect(h.onMoveBatch).toHaveBeenCalledWith('b1', 'down')
      fireEvent.click(screen.getByRole('button', { name: 'Move up: Queued solo' }))
      expect(h.onMove).toHaveBeenCalledWith('solo', 'up')
      // Nothing has started, so cancelling goes without asking.
      fireEvent.click(screen.getByRole('button', { name: 'Cancel batch: Recipe b1' }))
      expect(h.onCancelBatch).toHaveBeenCalledWith('b1')
      // A step can go on its own, but always asks first: it changes the rest.
      fireEvent.click(screen.getByRole('button', { name: 'Cancel: Queued s1' }))
      expect(h.onCancel).not.toHaveBeenCalled()
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel step' }))
      await waitFor(() => expect(h.onCancel).toHaveBeenCalledWith('s1'))
    })

    it('keeps a running batch step together with the steps before and after it', () => {
      renderTab({ jobs: [
        step(makeJob({ id: 'done', drive_guid: 'd1', status: 'completed', operation_name: 'Done s0', finished_at: '2026-11-11T18:00:00' }), 'b1', 0),
        step(running('r', 'd1'), 'b1', 1), step(queued('s2', 'd1', 0), 'b1', 2),
        queued('solo', 'd1', 1),
      ] })
      expect(header('b1').textContent).toMatch(/Recipe b12 \/ 3.*Run r running · stops on failure/)
      expect([...box('b1').querySelectorAll('.batch-steps .queue-op')].map(e => e.textContent)).toEqual(['Done s0', 'Run r', 'Queued s2'])
      expect(screen.queryByRole('button', { name: 'Move up: Recipe b1' })).not.toBeInTheDocument()
      // Up next starts after the batch, and its first step isn't also under Recently finished.
      const queue = lane(/Exos One/).querySelector('.act-queue')!
      expect(queue.textContent).toMatch(/^1.*Queued solo/)
      expect(screen.getAllByText('Done s0')).toHaveLength(1)
    })

    it('pins a started batch between its steps: nothing moves past it', () => {
      renderTab({ jobs: [
        step(makeJob({ id: 'done', drive_guid: 'd1', status: 'completed' }), 'b1', 0),
        step(queued('s1', 'd1', 0), 'b1', 1),
        queued('solo', 'd1', 1),
      ] })
      expect(screen.getByRole('button', { name: 'Move down: Recipe b1' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Move up: Queued solo' })).toBeDisabled()
      expect(header('b1').textContent).toMatch(/Recipe b12 \/ 2.*Queued s1 next/)
    })

    it("folds a batch's steps from its header", () => {
      renderTab({ jobs: [running('a', 'd1'), step(queued('s0', 'd1', 0), 'b1', 0), step(queued('s1', 'd1', 1), 'b1', 1)] })
      fireEvent.click(header('b1'))
      expect(within(box('b1')).queryByText('Queued s0')).not.toBeInTheDocument()
      fireEvent.click(header('b1'))
      expect(within(box('b1')).getByText('Queued s0')).toBeInTheDocument()
    })
  })
})
