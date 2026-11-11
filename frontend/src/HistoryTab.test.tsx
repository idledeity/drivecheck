import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HistoryTab from './HistoryTab'
import { mergeHistory } from './jobHistory'
import { fetchJsonResponse, makeDrive, makeJob } from './test/fixtures'
import type { Job } from './types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HistoryTab', () => {
  it('prompts for a selection when no drive is selected', () => {
    render(<HistoryTab drives={[]} selectedGuids={[]} jobs={[]} onCancel={() => {}} />)
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
  })

  it('fetches and renders job history for each selected drive', async () => {
    const drive = makeDrive({ guid: 'd1', model: 'ModelX' })
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([makeJob({ id: 'j1' })]))

    render(<HistoryTab drives={[drive]} selectedGuids={['d1']} jobs={[]} onCancel={() => {}} />)

    expect(fetch).toHaveBeenCalledWith('/api/jobs/history?guid=d1')
    // "ModelX" appears twice: once in DriveHistory's own header, once inside
    // the rendered JobRow's drive identity.
    await waitFor(() => expect(screen.getAllByText('ModelX').length).toBeGreaterThan(0))
    expect(screen.getByText('Full Read Test')).toBeInTheDocument()
  })

  it('shows an empty message when a drive has no completed jobs', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    render(<HistoryTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} jobs={[]} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByText('No completed jobs for this drive yet.')).toBeInTheDocument())
  })

  it('treats a fetch failure the same as an empty history', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))
    render(<HistoryTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} jobs={[]} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByText('No completed jobs for this drive yet.')).toBeInTheDocument())
  })

  it('renders one section per selected drive', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    render(<HistoryTab
      drives={[makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]}
      selectedGuids={['d1', 'd2']}
      jobs={[]}
      onCancel={() => {}}
    />)
    expect(fetch).toHaveBeenCalledWith('/api/jobs/history?guid=d1')
    expect(fetch).toHaveBeenCalledWith('/api/jobs/history?guid=d2')
  })

  it('shows a job finishing as soon as the live list does, without re-fetching', async () => {
    const drive = makeDrive({ guid: 'd1' })
    // Stored while running; the live list then reports it completed.
    const storedRunning = makeJob({ id: 'j1', drive_guid: 'd1', status: 'running', operation_name: 'Short Self-Test' })
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([storedRunning]))
    const row = () => screen.getByText('Short Self-Test').closest('.queue-row')
    const { rerender } = render(<HistoryTab drives={[drive]} selectedGuids={['d1']} jobs={[storedRunning]} onCancel={() => {}} />)
    await waitFor(() => expect(row()).toHaveClass('queue-row-running'))

    const done = { ...storedRunning, status: 'completed' as const, finished_at: '2026-11-11T10:42:58' }
    rerender(<HistoryTab drives={[drive]} selectedGuids={['d1']} jobs={[done]} onCancel={() => {}} />)
    expect(row()).toHaveClass('queue-row-completed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels a running job from its history row', async () => {
    const running = makeJob({ id: 'j1', drive_guid: 'd1', status: 'running' })
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([running]))
    const onCancel = vi.fn()
    render(<HistoryTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} jobs={[running]} onCancel={onCancel} />)
    fireEvent.click(await screen.findByTitle('Cancel'))
    expect(onCancel).toHaveBeenCalledWith('j1')
  })
})

describe('mergeHistory', () => {
  const at = (id: string, created_at: string, status: Job['status'] = 'completed') => makeJob({ id, created_at, status })

  it('prefers the live version of a stored job and adds live jobs not yet stored, newest first', () => {
    const stored = [at('a', '2026-11-11T09:00:00', 'running'), at('old', '2026-11-10T09:00:00')]
    const live = [at('a', '2026-11-11T09:00:00', 'completed'), at('new', '2026-11-11T10:00:00', 'failed')]
    expect(mergeHistory(stored, live).map(j => [j.id, j.status])).toEqual([
      ['new', 'failed'], ['a', 'completed'], ['old', 'completed'],
    ])
  })

  it('keeps jobs of every status', () => {
    const live = [at('r', '2026-11-11T10:00:00', 'running'), at('q', '2026-11-11T10:01:00', 'queued')]
    expect(mergeHistory([at('c', '2026-11-11T09:00:00')], live).map(j => j.id)).toEqual(['q', 'r', 'c'])
  })
})
