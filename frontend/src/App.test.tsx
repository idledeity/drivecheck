import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { AuthContext } from './authContext'
import { fetchJsonResponse, makeDrive, makeJob } from './test/fixtures'
import type { Drive, Job, OperationInfo, Settings } from './types'

vi.mock('./DriveCard', () => ({
  default: ({ drive, selected, onSelect, onSelectToggle, onContextMenu, job, queuedJobs, newResults = [] }: {
    drive: Drive
    selected: boolean
    onSelect: (e: React.MouseEvent) => void
    onSelectToggle: () => void
    onContextMenu?: (guid: string, pos: { x: number; y: number }) => void
    job?: Job
    queuedJobs: Job[]
    newResults?: Job[]
  }) => (
    <div data-testid={`drive-card-${drive.guid}`} data-selected={selected}>
      <span>{drive.model}</span>
      <button onClick={onSelect}>{`select-${drive.guid}`}</button>
      <button onClick={onSelectToggle}>{`toggle-${drive.guid}`}</button>
      <button onClick={() => onContextMenu?.(drive.guid, { x: 0, y: 0 })}>{`context-${drive.guid}`}</button>
      <span data-testid={`active-job-${drive.guid}`}>{job?.id ?? 'none'}</span>
      <span data-testid={`queued-count-${drive.guid}`}>{queuedJobs.length}</span>
      <span data-testid={`new-results-${drive.guid}`}>{newResults.map(j => j.id).join(',')}</span>
    </div>
  ),
}))

vi.mock('./DriveContextMenu', () => ({
  default: ({ guids, onRename, onClose }: {
    guids: string[]
    onRename: (guids: string[], label: string | null) => void
    onClose: () => void
  }) => (
    <div data-testid="context-menu">
      <button onClick={() => { onRename(guids, 'New Label'); onClose() }}>rename</button>
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
  destructive: false,
  params: [],
}

function makeFetchRouter(initial: { drives?: Drive[]; jobs?: Job[]; settings?: Settings } = {}) {
  const state = {
    drives: initial.drives ?? [],
    jobs: initial.jobs ?? [],
    settings: initial.settings ?? { footer_signals: {} },
    failNextDrivesLoad: false,
    // What POST /api/jobs answers: [body, status], or 'offline' for a failed request.
    runResponse: [[], 201] as [unknown, number] | 'offline',
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
    if (url === '/api/jobs' && method === 'POST') {
      if (state.runResponse === 'offline') return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve(fetchJsonResponse(...state.runResponse))
    }
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
  it('hands back to the login screen when a poll answers 401', async () => {
    const expire = vi.fn()
    router.fn.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/settings' ? fetchJsonResponse({ footer_signals: {} }) : fetchJsonResponse({ error: 'login required' }, 401)))
    render(
      <AuthContext.Provider value={{ username: 'admin', signOut: vi.fn(), expire }}>
        <App />
      </AuthContext.Provider>,
    )
    await waitFor(() => expect(expire).toHaveBeenCalled())
    expect(screen.queryByText(/Backend unavailable/)).not.toBeInTheDocument()
  })

  it('offers sign out next to Settings when signed in', async () => {
    const signOut = vi.fn()
    render(
      <AuthContext.Provider value={{ username: 'admin', signOut, expire: vi.fn() }}>
        <App />
      </AuthContext.Provider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalled()
  })

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

  it("hands each drive card its own unseen finished jobs, newest first", async () => {
    router.state.drives = [makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]
    router.state.settings = { footer_signals: {}, jobs_seen_at: '2026-11-11T12:00:00' }
    router.state.jobs = [
      makeJob({ id: 'seen', drive_guid: 'd1', status: 'completed', finished_at: '2026-11-11T11:00:00' }),
      makeJob({ id: 'older', drive_guid: 'd1', status: 'failed', finished_at: '2026-11-11T13:00:00' }),
      makeJob({ id: 'newer', drive_guid: 'd1', status: 'completed', finished_at: '2026-11-11T14:00:00' }),
      makeJob({ id: 'still-running', drive_guid: 'd2', status: 'running' }),
    ]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('new-results-d1')).toHaveTextContent('newer,older'))
    expect(screen.getByTestId('new-results-d2')).toHaveTextContent('')
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

  it('exclusively selects one drive and clears others on plain click', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select-d1'))
    expect(screen.getByTestId('drive-card-d1')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('drive-card-d2')).toHaveAttribute('data-selected', 'false')

    await userEvent.click(screen.getByText('select-d2'))
    expect(screen.getByTestId('drive-card-d1')).toHaveAttribute('data-selected', 'false')
    expect(screen.getByTestId('drive-card-d2')).toHaveAttribute('data-selected', 'true')
  })

  it('toggles drive selection via onSelectToggle (long press)', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('toggle-d1'))
    expect(screen.getByTestId('drive-card-d1')).toHaveAttribute('data-selected', 'true')

    await userEvent.click(screen.getByText('toggle-d1'))
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

    await userEvent.click(screen.getByText('context-d1'))
    await userEvent.click(screen.getByText('rename'))
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
    expect(sessionStorage.getItem('drivecheck.settingsOpen')).toBe('1')

    await userEvent.click(screen.getByText('close-settings'))
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('drivecheck.settingsOpen')).toBeNull()
  })

  it('reopens the settings overlay on mount if it was left open (e.g. a refresh)', async () => {
    sessionStorage.setItem('drivecheck.settingsOpen', '1')
    render(<App />)
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument()
  })

  it('cancels a job from the Activity tab', async () => {
    router.state.jobs = [makeJob({ id: 'job-1', status: 'running' })]
    render(<App />)
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/jobs'))

    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Activity' }))
    await userEvent.click(screen.getByTitle('Cancel'))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/jobs/job-1/cancel', expect.objectContaining({ method: 'POST' })))
  })

  it('runs an operation from the Run Task tab', async () => {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select-d1'))
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run Task' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Full Read Test' })).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(router.fn).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ guids: ['d1'], operation: 'dd_read_test', params: {} }),
    })))
  })

  async function runFromTasks() {
    router.state.drives = [makeDrive({ guid: 'd1' })]
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('drive-card-d1')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select-d1'))
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run Task' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Full Read Test' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
  }

  it('shows why the server refused a run, without calling the backend unavailable', async () => {
    router.state.runResponse = [{ error: "invalid parameter 'duration': must be at most 120" }, 400]
    await runFromTasks()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("invalid parameter 'duration': must be at most 120"))
    expect(screen.queryByText(/Backend unavailable/)).not.toBeInTheDocument()
  })

  it('says so when no selected drive could take the job', async () => {
    router.state.runResponse = [[], 201]
    await runFromTasks()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('None of the selected drives can run this operation'))
  })

  it('reports the backend unavailable only when the run request itself fails', async () => {
    router.state.runResponse = 'offline'
    await runFromTasks()
    await waitFor(() => expect(screen.getByText('Backend unavailable — retrying…')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
