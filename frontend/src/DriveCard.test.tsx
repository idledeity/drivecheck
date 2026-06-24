import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DriveCard from './DriveCard'
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
  const onLabelChange = vi.fn()
  render(<DriveCard
    drive={makeDrive()}
    selected={false}
    onSelect={onSelect}
    queuedJobs={[]}
    onLabelChange={onLabelChange}
    {...props}
  />)
  return { onSelect, onLabelChange }
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
  it('calls onSelect when the card is clicked', async () => {
    const { onSelect } = renderCard()
    await userEvent.click(screen.getByText('ModelX'))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('adds the selected class when selected', () => {
    renderCard({ selected: true })
    expect(screen.getByText('ModelX').closest('.drive-card')).toHaveClass('sel')
  })
})

describe('label editing', () => {
  it('shows an add-label button when the drive has no label', () => {
    renderCard({ drive: makeDrive({ label: null }) })
    expect(screen.getByTitle('Add label')).toBeInTheDocument()
  })

  it('shows the label and starts editing on click without selecting the card', async () => {
    const { onSelect } = renderCard({ drive: makeDrive({ label: 'NAS pool' }) })
    expect(screen.getByText('(NAS pool)')).toBeInTheDocument()
    await userEvent.click(screen.getByText('(NAS pool)'))
    expect(screen.getByPlaceholderText('Label…')).toHaveValue('NAS pool')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('commits a trimmed label on blur', async () => {
    const { onLabelChange } = renderCard({ drive: makeDrive({ guid: 'd1', label: null }) })
    await userEvent.click(screen.getByTitle('Add label'))
    await userEvent.type(screen.getByPlaceholderText('Label…'), '  New Label  ')
    fireEvent.blur(screen.getByPlaceholderText('Label…'))
    expect(onLabelChange).toHaveBeenCalledWith('d1', 'New Label')
  })

  it('commits null when the input is cleared to blank', async () => {
    const { onLabelChange } = renderCard({ drive: makeDrive({ guid: 'd1', label: 'Old' }) })
    await userEvent.click(screen.getByText('(Old)'))
    await userEvent.clear(screen.getByPlaceholderText('Label…'))
    fireEvent.blur(screen.getByPlaceholderText('Label…'))
    expect(onLabelChange).toHaveBeenCalledWith('d1', null)
  })

  it('does not call onLabelChange when the value is unchanged', async () => {
    const { onLabelChange } = renderCard({ drive: makeDrive({ guid: 'd1', label: 'Same' }) })
    await userEvent.click(screen.getByText('(Same)'))
    fireEvent.blur(screen.getByPlaceholderText('Label…'))
    expect(onLabelChange).not.toHaveBeenCalled()
  })

  it('cancels the edit on Escape without committing', async () => {
    const { onLabelChange } = renderCard({ drive: makeDrive({ guid: 'd1', label: 'Old' }) })
    await userEvent.click(screen.getByText('(Old)'))
    await userEvent.clear(screen.getByPlaceholderText('Label…'))
    await userEvent.type(screen.getByPlaceholderText('Label…'), 'Discarded')
    await userEvent.keyboard('{Escape}')
    expect(onLabelChange).not.toHaveBeenCalled()
    expect(screen.getByText('(Old)')).toBeInTheDocument()
  })

  it('commits on Enter', async () => {
    const { onLabelChange } = renderCard({ drive: makeDrive({ guid: 'd1', label: null }) })
    await userEvent.click(screen.getByTitle('Add label'))
    await userEvent.type(screen.getByPlaceholderText('Label…'), 'Quick{Enter}')
    expect(onLabelChange).toHaveBeenCalledWith('d1', 'Quick')
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
    expect(screen.getByText('5').closest('.dc-stat-value')).toHaveClass('crit')
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
    renderCard({ job: makeJob({ status: 'running', category: 'Scan' }) })
    await userEvent.click(document.querySelector('.dc-tz')!)
    await waitFor(() => expect(screen.getByText('Category')).toBeInTheDocument())
    expect(screen.getByText('Scan')).toBeInTheDocument()
  })

  it('toggles the task popover closed on a second click', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    const tz = document.querySelector('.dc-tz')!
    await userEvent.click(tz)
    await waitFor(() => expect(screen.getByText('Category')).toBeInTheDocument())
    await userEvent.click(tz)
    expect(screen.queryByText('Category')).not.toBeInTheDocument()
  })

  it('opens the queued popover from the pill, independent of the task popover', async () => {
    renderCard({
      job: makeJob({ status: 'running' }),
      queuedJobs: [makeJob({ id: 'q1', operation_name: 'Sleep (debug)', category: 'Debug' })],
    })
    await userEvent.click(screen.getByText('1 queued'))
    await waitFor(() => expect(screen.getByText('Sleep (debug)')).toBeInTheDocument())
    expect(screen.queryByText('Category')).not.toBeInTheDocument()
  })

  it('closes the popover on an outside click', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    await userEvent.click(document.querySelector('.dc-tz')!)
    await waitFor(() => expect(screen.getByText('Category')).toBeInTheDocument())

    await userEvent.click(document.body)
    expect(screen.queryByText('Category')).not.toBeInTheDocument()
  })

  it('does not open a popover for a queued (not running) job from a plain click', async () => {
    renderCard({ job: makeJob({ status: 'queued', category: 'Scan' }) })
    await userEvent.click(document.querySelector('.dc-tz')!)
    await waitFor(() => expect(screen.getByText('Category')).toBeInTheDocument())
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
    expect(screen.queryByText('Category')).not.toBeInTheDocument()

    // The hover-intent timer's setPopover() fires outside any React event
    // handler, so React doesn't know to batch/flush it unless the timer
    // advance itself is wrapped in act().
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Category')).toBeInTheDocument()
  })

  it('closes the popover on mouse leave', async () => {
    renderCard({ job: makeJob({ status: 'running' }) })
    const tz = document.querySelector('.dc-tz')!
    fireEvent.mouseEnter(tz, { clientX: 10, clientY: 10 })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Category')).toBeInTheDocument()

    fireEvent.mouseLeave(tz)
    expect(screen.queryByText('Category')).not.toBeInTheDocument()
  })

  it('clicking the card while hover-capable just selects it, not the popover', async () => {
    const { onSelect } = renderCard({ job: makeJob({ status: 'running' }) })
    fireEvent.click(document.querySelector('.dc-tz')!)
    expect(onSelect).toHaveBeenCalledOnce()
  })
})
