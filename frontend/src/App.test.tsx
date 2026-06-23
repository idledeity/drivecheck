import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { fetchJsonResponse, makeDrive, makeJob } from './test/fixtures'
import type { Drive, Job, OperationInfo, Settings } from './types'

vi.mock('./DriveCard', () => ({
  default: ({ drive, selected, onSelect, onLabelChange, job, queuedJobs }: {
    drive: Drive
    selected: boolean
    onSelect: () => void
    onLabelChange?: (guid: string, label: string | null) => void
    job?: Job
    queuedJobs: Job[]
  }) => (
    <div data-testid={`drive-card-${drive.guid}`} data-selected={selected}>
      <span>{drive.model}</span>
      <button onClick={onSelect}>{`select-${drive.guid}`}</button>
      <button onClick={() => onLabelChange?.(drive.guid, 'New Label')}>{`relabel-${drive.guid}`}</button>
      <span data-testid={`active-job-${drive.guid}`}>{job?.id ?? 'none'}</span>
      <span data-testid={`queued-count-${drive.guid}`}>{queuedJobs.length}</span>
    </div>
  ),
}))

vi.mock('./SettingsOverlay', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="settings-overlay">
      <button onClick={onClose}>close-settings</button>
    </div>
  ),
}))

const READ_TEST: OperationInfo = {
  key: 'dd_read_test',
  name: 'Full Read Test',
  category: 'Scan',
  tool: 'dd',
  params: [],
}

function makeFetchRouter(initial: { drives?: Drive[]; jobs?: Job[]; settings?: Settings } = {}) {
  const state = {
    drives: initial.drives ?? [],
    jobs: initial.jobs ?? [],
    settings: initial.settings ?? { footer_signals: {} },
    failNextDrivesLoad: false,
  }
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/settings') return Promise.resolve(fetchJsonResponse(state.settings))
    if (url === '/api/drives') {
      if (state.failNextDrivesLoad) {
        state.failNextDrivesLoad = false
        return Promise.resolve(fetchJsonResponse(null, 500))
      }
      return Promise.resolve(fetchJsonResponse(state.drives))
    }
    if (url === '/api/jobs' && method === 'GET') return Promise.resolve(fetchJsonResponse(state.jobs))
    if (url.startsWith('/api/operations')) return Promise.resolve(fetchJsonResponse([READ_TEST]))
    // Every other endpoint (cancel, run, refresh, scan, label patch) just
    // needs to look like a successful response — App reloads drives/jobs
    // itself afterward via the GET routes above.
    return Promise.resolve(fetchJsonResponse({}))
  })
  return { fn, state }
}

let router: ReturnType<typeof makeFetchRouter>

beforeEach(() => {
  router = makeFetchRouter()
  vi.stubGlobal('fetch', router.fn)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('App', () => {
  it('fetches settings, drives, and jobs on mount', async () => {
    render(<App />)
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/settings'))
    expect(router.fn).toHaveBeenCalledWith('/api/drives')
    expect(router.fn).toHaveBeenCalledWith('/api/jobs')
  })

  it('shows a scanning placeholder until drives load, then renders a card per drive', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]
    render(<App />)
    expect(screen.getByText('Scanning…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())
    expect(screen.getByTestId('drive-card-d2')).toBeInTheDocument()
  })

  it('prefers a running job over a queued one as the drive-card-active job', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    router.state.jobs = [
      makeJob({ id: 'queued-1', drive_guid: 'd1', status: 'queued' }),
      makeJob({ id: 'running-1', drive_guid: 'd1', status: 'running' }),
    ]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('active-job-d1')).toHaveTextContent('running-1'))
    expect(screen.getByTestId('queued-count-d1')).toHaveTextContent('1')
  })

  it('polls drives and jobs every 2 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<App />)
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/drives'))
    const callsBefore = router.fn.mock.calls.filter(c => c[0] === '/api/drives').length

    await vi.advanceTimersByTimeAsync(2_000)

    const callsAfter = router.fn.mock.calls.filter(c => c[0] === '/api/drives').length
    expect(callsAfter).toBeGreaterThan(callsBefore)
  })

  it('shows a retry message when loading drives fails, and clears it once a load succeeds', async () => {
    router.state.failNextDrivesLoad = true
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend unavailable — retrying…')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(screen.queryByText('Backend unavailable — retrying…')).not.toBeInTheDocument())
  })

  it('selecting all via GridControls marks every drive card selected', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByTitle('Select all drives'))
    expect(screen.getByTestId('drive-card-d1')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('drive-card-d2')).toHaveAttribute('data-selected', 'true')
  })

  it("toggles a single drive's selection via its card", async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select-d1'))
    expect(screen.getByTestId('drive-card-d1')).toHaveAttribute('data-selected', 'true')

    await userEvent.click(screen.getByText('select-d1'))
    expect(screen.getByTestId('drive-card-d1')).toHaveAttribute('data-selected', 'false')
  })

  it('probes with no body guids when nothing is selected', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByTitle('Probe all drives'))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/drives/refresh', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ guids: undefined }),
    })))
  })

  it('probes with the selected guids when drives are selected', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select-d1'))
    await userEvent.click(screen.getByTitle('Probe selected (1)'))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/drives/refresh', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ guids: ['d1'] }),
    })))
  })

  it('scans for drives via GridControls', async () => {
    render(<App />)
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/drives'))
    await userEvent.click(screen.getByTitle('Scan for drives'))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/drives/scan', expect.objectContaining({ method: 'POST' })))
  })

  it('optimistically relabels a drive and PATCHes the backend', async () => {
    router.state.drives = [makeDrive({ guid: 'd1', model: 'ModelX', label: null })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('relabel-d1'))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/drives/d1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ label: 'New Label' }),
    })))
  })

  it('opens and closes the settings overlay', async () => {
    render(<App />)
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Settings'))
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument()

    await userEvent.click(screen.getByText('close-settings'))
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument()
  })

  it('cancels a job from the Queue tab', async () => {
    router.state.jobs = [makeJob({ id: 'job-1', status: 'running' })]
    render(<App />)
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/jobs'))

    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    await userEvent.click(screen.getByTitle('Cancel'))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/jobs/job-1/cancel', expect.objectContaining({ method: 'POST' })))
  })

  it('runs an operation from the Run Task tab', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select-d1'))
    await userEvent.click(screen.getByRole('button', { name: 'Run Task' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Full Read Test' })).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ guids: ['d1'], operation: 'dd_read_test', params: {} }),
    })))
  })
})
