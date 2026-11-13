import { act } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DriveCard from './DriveCard'
import { JobsContext } from './jobsContext'
import ConfirmProvider from './ConfirmProvider'
import { makeDrive, makeJob } from './test/fixtures'

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

beforeEach(() => {
  // Default to a touch-like device (no hover) — that path drives popovers
  // via plain clicks, which is far simpler to test deterministically than
  // the hover-intent timer path. A handful of tests below override this.
  mockMatchMedia(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderCard(props: Partial<Parameters<typeof DriveCard>[0]> = {}) {
  const onSelect = vi.fn()
  const onSelectToggle = vi.fn()
  render(<DriveCard
    drive={makeDrive()}
    selected={false}
    onSelect={onSelect}
    onSelectToggle={onSelectToggle}
    queuedJobs={[]}
    {...props}
  />)
  return { onSelect, onSelectToggle }
}

describe('health badge', () => {
  it.each([
    ['Healthy', 'SMART OK'],
    ['Degraded', 'Degraded'],
    ['Failing', 'Failing'],
  ] as const)('shows "%s" as "%s"', (status, label) => {
    renderCard({ drive: makeDrive({ health_status: status }) })
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('shows Unrated when health_status is null', () => {
    renderCard({ drive: makeDrive({ health_status: null }) })
    expect(screen.getByText('Unrated')).toBeInTheDocument()
  })
})

describe('identity row', () => {
  it('renders manufacturer and model', () => {
    renderCard({ drive: makeDrive({ manufacturer: 'Acme', model: 'ModelX' }) })
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('ModelX')).toBeInTheDocument()
  })

  it('falls back to the device path when model is null', () => {
    renderCard({ drive: makeDrive({ model: null, device: '/dev/sdz' }) })
    expect(document.querySelector('.dc-model')).toHaveTextContent('/dev/sdz')
  })

  it('omits capacity in the identity row when null', () => {
    renderCard({ drive: makeDrive({ capacity_bytes: null }) })
    expect(screen.queryByText(/TB|GB|MB/)).not.toBeInTheDocument()
  })
})

describe('selection', () => {
  it('calls onSelect when the card is clicked on hover-capable devices', async () => {
    mockMatchMedia(true)
    const { onSelect } = renderCard()
    await userEvent.click(screen.getByText('ModelX'))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('adds the selected class when selected', () => {
    renderCard({ selected: true })
    expect(screen.getByText('ModelX').closest('.drive-card')).toHaveClass('sel')
  })
})

describe('label display', () => {
  it('shows the label when the drive has one', () => {
    renderCard({ drive: makeDrive({ label: 'NAS pool' }) })
    expect(screen.getByText('(NAS pool)')).toBeInTheDocument()
  })

  it('shows nothing for the label when the drive has none', () => {
    renderCard({ drive: makeDrive({ label: null }) })
    expect(document.querySelector('.dc-label')).not.toBeInTheDocument()
  })
})

describe('traits row', () => {
  it('renders drive type, rpm, and bus when present', () => {
    renderCard({ drive: makeDrive({ drive_type: 'HDD', rpm: 7200, bus: 'SATA III' }) })
    expect(screen.getByText('HDD')).toBeInTheDocument()
    expect(screen.getByText('7.2k RPM')).toBeInTheDocument()
    expect(screen.getByText('SATA III')).toBeInTheDocument()
  })

  it('omits rpm for drives without one (e.g. SSDs)', () => {
    renderCard({ drive: makeDrive({ rpm: null }) })
    expect(screen.queryByText(/RPM/)).not.toBeInTheDocument()
  })
})

describe('state row', () => {
  it('shows the device path', () => {
    renderCard({ drive: makeDrive({ device: '/dev/sdq' }) })
    expect(screen.getByText('/dev/sdq')).toBeInTheDocument()
  })

  it('prefers live vitals temp over the polled temp', () => {
    renderCard({ drive: makeDrive({ temp: 30, vitals: {
      temp: 50, temp_source: 'smartctl', captured_at: null,
      io: { read_iops: null, write_iops: null, read_bytes_per_sec: null, write_bytes_per_sec: null, busy_pct: null },
    } }) })
    expect(screen.getByText('50°C')).toBeInTheDocument()
  })

  it('falls back to the polled temp when vitals has none', () => {
    renderCard({ drive: makeDrive({ temp: 30 }) })
    expect(screen.getByText('30°C')).toBeInTheDocument()
  })

  it('marks temp hot when signal_flags.temp is warn', () => {
    renderCard({ drive: makeDrive({ temp: 55, signal_flags: { temp: 'warn' } }) })
    expect(screen.getByText('55°C')).toHaveClass('hot')
  })

  it('shows mounted vs unmounted status', () => {
    renderCard({ drive: makeDrive({ is_mounted: true }) })
    expect(screen.getByText('mounted')).toBeInTheDocument()
    renderCard({ drive: makeDrive({ is_mounted: false }) })
    expect(screen.getByText('unmounted')).toBeInTheDocument()
  })
})

describe('task zone', () => {
  it('shows Idle when there is no job', () => {
    renderCard({ job: undefined })
    expect(screen.getByText('Idle')).toBeInTheDocument()
  })

  it('shows the queued operation name when queued', () => {
    renderCard({ job: makeJob({ status: 'queued', operation_name: 'Full Read Test' }) })
    expect(screen.getByText('Queued: Full Read Test')).toBeInTheDocument()
  })

  it('shows a determinate progress bar and percent when running with a known percent', () => {
    renderCard({ job: makeJob({
      status: 'running', operation_name: 'Full Read Test',
      progress: { percent: 42.5, message: null, eta_seconds: null },
    }) })
    expect(screen.getByText('Full Read Test')).toBeInTheDocument()
    expect(screen.getByText('42.5%')).toBeInTheDocument()
  })

  it('shows an indeterminate bar when percent is null', () => {
    renderCard({ job: makeJob({ status: 'running', progress: { percent: null, message: null, eta_seconds: null } }) })
    expect(document.querySelector('.dc-tz-bar-fill.indeterminate')).toBeInTheDocument()
  })

  it('shows the progress message when present', () => {
    renderCard({ job: makeJob({
      status: 'running',
      progress: { percent: 10, message: 'Reading sector 1234', eta_seconds: null },
    }) })
    expect(screen.getByText('Reading sector 1234')).toBeInTheDocument()
  })

  it('shows a queued-count pill when other jobs are queued for this drive', () => {
    renderCard({
      job: makeJob({ status: 'running' }),
      queuedJobs: [makeJob({ id: 'q1' }), makeJob({ id: 'q2' })],
    })
    expect(screen.getByText('2 queued')).toBeInTheDocument()
  })
})

describe('footer signals', () => {
  it('renders the default signal set for a non-SAS drive', () => {
    renderCard({ drive: makeDrive({ drive_type: 'HDD', power_on_hours: 1234 }) })
    expect(screen.getByText('Power-on')).toBeInTheDocument()
    expect(screen.getByText('1,234h')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('renders the SAS signal set (load/unload instead of pending) for SAS drives', () => {
    renderCard({ drive: makeDrive({ drive_type: 'SAS', load_unload_cycles: 99 }) })
    expect(screen.getByText('Ld/UL')).toBeInTheDocument()
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  })

  it('respects a footerSignals override from settings', () => {
    renderCard({ footerSignals: { default: ['temp'] }, drive: makeDrive({ temp: 40 }) })
    expect(screen.getByText('Temp')).toBeInTheDocument()
    expect(screen.queryByText('Power-on')).not.toBeInTheDocument()
  })

  it('flags a stat as crit based on signal_flags', () => {
    renderCard({ drive: makeDrive({ reallocated: 5, signal_flags: { reallocated: 'crit' } }) })
    expect(screen.getByText('5')).toHaveClass('dc-stat-value', 'sig-crit')
  })

  it('renders read/write throughput', () => {
    renderCard({ drive: makeDrive({ vitals: {
      temp: null, temp_source: null, captured_at: null,
      io: { read_iops: null, write_iops: null, read_bytes_per_sec: 2e6, write_bytes_per_sec: 1e6, busy_pct: null },
    } }) })
    expect(screen.getByText('2.0 MB/s')).toBeInTheDocument()
    expect(screen.getByText('1.0 MB/s')).toBeInTheDocument()
  })
})

describe('popovers (click-only / no-hover device)', () => {
  it('opens the task popover on click and shows job details', async () => {
    renderCard({ job: makeJob({
      status: 'running', settings: [{ name: 'passes', label: 'Write/read passes', value: 1 }],
    }) })
    await userEvent.click(document.querySelector('.dc-tz')!)
    await waitFor(() => expect(screen.getByText('Result')).toBeInTheDocument())
    expect(screen.getByText('Write/read passes')).toBeInTheDocument()
  })

  it('toggles the task popover closed on a second click', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    const tz = document.querySelector('.dc-tz')!
    await userEvent.click(tz)
    await waitFor(() => expect(screen.getByText('Result')).toBeInTheDocument())
    await userEvent.click(tz)
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
  })

  it('opens the queued popover from the pill, independent of the task popover', async () => {
    renderCard({
      job: makeJob({ status: 'running' }),
      queuedJobs: [makeJob({ id: 'q1', operation_name: 'Sleep (debug)', category: 'Debug' })],
    })
    await userEvent.click(screen.getByText('1 queued'))
    await waitFor(() => expect(screen.getByText('Sleep (debug)')).toBeInTheDocument())
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
  })

  it('closes the popover on an outside click', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    await userEvent.click(document.querySelector('.dc-tz')!)
    await waitFor(() => expect(screen.getByText('Result')).toBeInTheDocument())

    await userEvent.click(document.body)
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
  })

  it('lists the unseen results from the complete pill, with how each ended', async () => {
    renderCard({ newResults: [
      makeJob({ id: 'r1', status: 'failed', operation_name: 'Short Test', error: 'Self-test aborted' }),
      makeJob({ id: 'r2', status: 'completed', operation_name: 'Badblocks', summary: 'No bad blocks' }),
    ] })
    await userEvent.click(screen.getByText('2 complete'))
    const popover = document.querySelector('.dc-popover')!
    expect(popover).toHaveTextContent('Short Test')
    expect(popover).toHaveTextContent('Self-test aborted')
    expect(popover).toHaveTextContent('Badblocks')
    expect(popover).toHaveTextContent('No bad blocks')
  })

  it('shows the health overview from the health badge, without selecting the card', async () => {
    const { onSelectToggle } = renderCard({ drive: makeDrive({ health_pct: 87, health_status: 'Degraded' }) })
    await userEvent.click(screen.getByText('Degraded'))
    const popover = document.querySelector('.dc-popover')!
    expect(popover).toHaveTextContent('87')
    expect(popover).toHaveTextContent('No flagged signals')
    expect(onSelectToggle).not.toHaveBeenCalled()
  })

  function renderWithJobs(job: ReturnType<typeof makeJob>) {
    const cancelJob = vi.fn()
    render(
      <JobsContext.Provider value={{ jobs: [], unseen: [], cancelJob, moveJob: vi.fn(), runOperation: vi.fn(), markJobsSeen: vi.fn() }}><ConfirmProvider>
        <DriveCard drive={makeDrive()} selected={false} onSelect={vi.fn()} onSelectToggle={vi.fn()} job={job} queuedJobs={[]} />
      </ConfirmProvider></JobsContext.Provider>,
    )
    return cancelJob
  }

  it('cancels a running task from its popover after the confirm pop-up, and closes the popover', async () => {
    const cancelJob = renderWithJobs(makeJob({ id: 'j1', status: 'running', operation_name: 'Badblocks' }))
    await userEvent.click(document.querySelector('.dc-tz')!)
    await userEvent.click(within(document.querySelector('.dc-popover') as HTMLElement).getByRole('button', { name: 'Cancel: Badblocks' }))
    expect(cancelJob).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    expect(cancelJob).toHaveBeenCalledWith('j1')
    expect(document.querySelector('.dc-popover')).not.toBeInTheDocument()
  })

  it('has an × on the task row itself, which asks before ending a running task', async () => {
    const cancelJob = renderWithJobs(makeJob({ id: 'j1', status: 'running', operation_name: 'Badblocks' }))
    await userEvent.click(within(document.querySelector('.dc-tn') as HTMLElement).getByRole('button', { name: 'Cancel: Badblocks' }))
    expect(document.querySelector('.dc-popover')).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Cancel Badblocks?')
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(cancelJob).not.toHaveBeenCalled()
  })

  it('cancels a task that is only queued from the task row without asking', async () => {
    const cancelJob = renderWithJobs(makeJob({ id: 'j1', status: 'queued', operation_name: 'Badblocks' }))
    await userEvent.click(within(document.querySelector('.dc-tn') as HTMLElement).getByRole('button', { name: 'Cancel: Badblocks' }))
    expect(cancelJob).toHaveBeenCalledWith('j1')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('cancels a queued job from the queued popover', async () => {
    const cancelJob = vi.fn()
    render(
      <JobsContext.Provider value={{ jobs: [], unseen: [], cancelJob, moveJob: vi.fn(), runOperation: vi.fn(), markJobsSeen: vi.fn() }}><ConfirmProvider>
        <DriveCard
          drive={makeDrive()} selected={false} onSelect={vi.fn()} onSelectToggle={vi.fn()}
          job={makeJob({ status: 'running' })}
          queuedJobs={[makeJob({ id: 'q1', status: 'queued', operation_name: 'Sleep (debug)' })]}
        />
      </ConfirmProvider></JobsContext.Provider>,
    )
    await userEvent.click(screen.getByText('1 queued'))
    await userEvent.click(within(document.querySelector('.dc-popover') as HTMLElement).getByTitle('Cancel'))
    expect(cancelJob).toHaveBeenCalledWith('q1')
    expect(screen.getByText('Sleep (debug)')).toBeInTheDocument()
  })

  it('does not open a popover for a queued (not running) job from a plain click', async () => {
    renderCard({ job: makeJob({ status: 'queued', category: 'Scan' }) })
    await userEvent.click(document.querySelector('.dc-tz')!)
    await waitFor(() => expect(screen.getByText('Result')).toBeInTheDocument())
  })
})

describe('long press (touch)', () => {
  it('opens the context menu after holding, and the release does not toggle selection', () => {
    vi.useFakeTimers()
    const onContextMenu = vi.fn()
    const { onSelectToggle } = renderCard({ onContextMenu })
    const card = document.querySelector('.drive-card')!
    fireEvent.pointerDown(card, { clientX: 30, clientY: 40 })
    act(() => { vi.advanceTimersByTime(500) })
    expect(onContextMenu).toHaveBeenCalledWith('guid-1', { x: 30, y: 40 })
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onSelectToggle).not.toHaveBeenCalled()
    fireEvent.click(card)
    expect(onSelectToggle).toHaveBeenCalledOnce()
  })

  it('treats a short press as a tap', () => {
    vi.useFakeTimers()
    const onContextMenu = vi.fn()
    const { onSelectToggle } = renderCard({ onContextMenu })
    const card = document.querySelector('.drive-card')!
    fireEvent.pointerDown(card)
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    act(() => { vi.advanceTimersByTime(500) })
    expect(onContextMenu).not.toHaveBeenCalled()
    expect(onSelectToggle).toHaveBeenCalledOnce()
  })
})

describe('popovers (hover-capable device)', () => {
  beforeEach(() => {
    mockMatchMedia(true)
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  it('opens the task popover after the hover-intent delay', async () => {
    renderCard({ job: makeJob({ status: 'running', category: 'Scan' }) })
    const tz = document.querySelector('.dc-tz')!
    fireEvent.mouseEnter(tz, { clientX: 10, clientY: 10 })
    expect(screen.queryByText('Result')).not.toBeInTheDocument()

    // The hover-intent timer's setPopover() fires outside any React event
    // handler, so React doesn't know to batch/flush it unless the timer
    // advance itself is wrapped in act().
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  it('closes the popover on mouse leave', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    const tz = document.querySelector('.dc-tz')!
    fireEvent.mouseEnter(tz, { clientX: 10, clientY: 10 })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Result')).toBeInTheDocument()

    fireEvent.mouseLeave(tz)
    expect(screen.getByText('Result')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
  })

  it('stays open while the pointer is over the popover', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    const tz = document.querySelector('.dc-tz')!
    fireEvent.mouseEnter(tz, { clientX: 10, clientY: 10 })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    fireEvent.mouseLeave(tz)
    fireEvent.mouseEnter(document.querySelector('.dc-popover')!)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  it('opens the queued list, not the task details, when resting on the pill inside the task bar', async () => {
    renderCard({
      job: makeJob({ status: 'running' }),
      queuedJobs: [makeJob({ id: 'q1', operation_name: 'Sleep (debug)', category: 'Debug' })],
    })
    const tz = document.querySelector('.dc-tz')!
    const pill = screen.getByText('1 queued')
    fireEvent.mouseEnter(tz, { clientX: 10, clientY: 10 })
    fireEvent.mouseEnter(pill, { clientX: 200, clientY: 10 })
    fireEvent.mouseMove(pill, { clientX: 201, clientY: 10 })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Sleep (debug)')).toBeInTheDocument()
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
  })

  it('clicking the card while hover-capable just selects it, not the popover', async () => {
    const { onSelect } = renderCard({ job: makeJob({ status: 'running' }) })
    fireEvent.click(document.querySelector('.dc-tz')!)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  describe('complete pill', () => {
    const pill = () => screen.queryByText(/\d+ complete$/)

    it('is absent without unseen results', () => {
      renderCard()
      expect(pill()).not.toBeInTheDocument()
    })

    it('shows on an idle drive', () => {
      renderCard({ newResults: [makeJob({ status: 'failed', operation_name: 'Short Test' })] })
      expect(pill()).toHaveTextContent('1 complete')
    })

    it('sits next to the queued pill while a job runs', () => {
      renderCard({
        job: makeJob({ status: 'running' }),
        queuedJobs: [makeJob({ id: 'q', status: 'queued' })],
        newResults: [makeJob({ id: 'a' }), makeJob({ id: 'b' }), makeJob({ id: 'c' })],
      })
      expect(pill()).toHaveTextContent('3 complete')
      expect(pill()!.parentElement).toBe(screen.getByText('1 queued').parentElement)
    })

    it('shows while the next job is only queued', () => {
      renderCard({ job: makeJob({ status: 'queued' }), newResults: [makeJob({ id: 'a' })] })
      expect(pill()).toHaveTextContent('1 complete')
    })
  })
})
