import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HistoryTab from './HistoryTab'
import { mergeHistory } from './jobHistory'
import { toLocalIso } from './format'
import { fetchJsonResponse, makeDrive, makeJob } from './test/fixtures'
import type { Job } from './types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HistoryTab', () => {
  // 2026-11-11 19:30 local; stored times are local ISO strings without an offset.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 11, 19, 30)) })
  afterEach(() => { vi.useRealTimers() })

  const done = (o: Partial<Job>) => makeJob({ status: 'completed', category: 'Scan', started_at: '2026-11-11T09:00:00', finished_at: '2026-11-11T10:00:00', ...o })
  const renderTab = (props: Partial<React.ComponentProps<typeof HistoryTab>> = {}) =>
    render(<HistoryTab drives={[makeDrive({ guid: 'd1', model: 'ModelX' }), makeDrive({ guid: 'd2', model: 'ModelY' })]} selectedGuids={[]} jobs={[]} onCancel={() => {}} {...props} />)
  // Operation names also appear in the Operation dropdown, so read rows only.
  const ops = () => [...document.querySelectorAll('.queue-op')].map(e => e.textContent)
  const rowFor = (name: string) => [...document.querySelectorAll('.queue-op')].find(e => e.textContent === name)?.closest('.queue-row')
  // 14 x 24 h ago, which crosses the DST change in early November.
  const since14d = () => toLocalIso(Date.now() - 14 * 24 * 3600e3)

  it('fetches the last 14 days across every drive by default', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([done({ id: 'j1', drive_guid: 'd2', operation_name: 'Full Read Test' })]))
    renderTab()
    expect(fetch).toHaveBeenCalledWith(`/api/jobs/history?limit=500&since=${encodeURIComponent(since14d())}`)
    await waitFor(() => expect(ops()).toEqual(['Full Read Test']))
    expect(screen.getByText('1 job')).toBeInTheDocument()
  })

  it('refetches when the time range changes, without since for All', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'All' , pressed: false }))
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/jobs/history?limit=500'))
  })

  it('filters by status with counts, and never drops the last status', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([
      done({ id: 'a', operation_name: 'Good Run' }),
      done({ id: 'b', status: 'failed', error: 'boom', operation_name: 'Bad Run' }),
    ]))
    renderTab()
    await waitFor(() => expect(ops()).toHaveLength(2))
    const completed = screen.getByRole('button', { name: /Completed/ })
    expect(completed).toHaveTextContent('Completed 1')
    fireEvent.click(completed)
    expect(ops()).toEqual(['Bad Run'])
    fireEvent.click(screen.getByRole('button', { name: /Cancelled/ }))
    fireEvent.click(screen.getByRole('button', { name: /Interrupted/ }))
    fireEvent.click(screen.getByRole('button', { name: /Failed/ }))   // the only one left: stays on
    expect(screen.getByRole('button', { name: /Failed/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('hides debug jobs unless included', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([done({ id: 'dbg', category: 'Debug', operation_name: 'Sleep (debug)' })]))
    renderTab()
    expect(await screen.findByText('0 jobs · 1 debug job hidden')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Include debug jobs'))
    expect(ops()).toEqual(['Sleep (debug)'])
  })

  it('limits to the selected drives when asked', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([
      done({ id: 'a', drive_guid: 'd1', operation_name: 'On One' }),
      done({ id: 'b', drive_guid: 'd2', operation_name: 'On Two' }),
    ]))
    renderTab({ selectedGuids: ['d2'] })
    await waitFor(() => expect(ops()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Selected (1)' }))
    expect(ops()).toEqual(['On Two'])
  })

  it('disables Selected when nothing is selected', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    renderTab()
    expect(screen.getByRole('button', { name: 'Selected (0)' })).toBeDisabled()
  })

  it('sorts newest first with day dividers, or by duration', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([
      done({ id: 'y', operation_name: 'Yesterday Long', started_at: '2026-11-10T01:00:00', finished_at: '2026-11-10T09:00:00' }),
      done({ id: 't', operation_name: 'Today Short', started_at: '2026-11-11T09:55:00', finished_at: '2026-11-11T10:00:00' }),
    ]))
    renderTab()
    await waitFor(() => expect(ops()).toEqual(['Today Short', 'Yesterday Long']))
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Today', 'Yesterday'])
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'long' } })
    expect(ops()).toEqual(['Yesterday Long', 'Today Short'])
    expect(screen.queryAllByRole('heading')).toEqual([])
  })

  it('groups by drive under drive chips', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([
      done({ id: 'a', drive_guid: 'd1', operation_name: 'First' }),
      done({ id: 'b', drive_guid: 'd2', operation_name: 'Second' }),
    ]))
    renderTab()
    await waitFor(() => expect(ops()).toHaveLength(2))
    fireEvent.click(screen.getByLabelText('Group by drive'))
    expect(document.querySelectorAll('.history-group')).toHaveLength(2)
  })

  it('shows a job as soon as the live list reports it finished, without refetching', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    const running = makeJob({ id: 'live', drive_guid: 'd1', status: 'running', operation_name: 'Short Self-Test', category: 'Test' })
    const { rerender } = renderTab({ jobs: [running] })
    await screen.findByText(/No jobs finished in the last 14d/)
    expect(ops()).toEqual([])   // running jobs live in Activity

    const finished = { ...running, status: 'completed' as const, finished_at: '2026-11-11T19:20:00' }
    rerender(<HistoryTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={[]} jobs={[finished]} onCancel={() => {}} />)
    expect(rowFor('Short Self-Test')).toHaveClass('queue-row-completed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('offers all time when the range is empty, and treats a failed fetch as empty', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Show all time' }))
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/jobs/history?limit=500'))
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
