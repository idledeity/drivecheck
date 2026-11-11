import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DetailRow, JobDetailRows, JobDetails, JobSmartPanel } from './JobDetails'
import { jobResultText } from './format'
import { makeJob } from './test/fixtures'
import type { JobSmart, JobSmartSnapshot } from './types'

// The value cell next to a label, for "label: value" detail rows.
function valueOf(label: string): string | null {
  const row = screen.getByText(label).closest('.job-detail-row')
  return row?.querySelector('.job-detail-value')?.textContent ?? null
}

describe('DetailRow', () => {
  it('renders the label and value', () => {
    render(<DetailRow label="Status" value="Completed" />)
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })
})

describe('jobResultText', () => {
  it('uses the operation summary for a completed job, else a plain "Completed"', () => {
    expect(jobResultText(makeJob({ status: 'completed', summary: 'Read 6.0 TB with no errors' })))
      .toBe('Read 6.0 TB with no errors')
    expect(jobResultText(makeJob({ status: 'completed', summary: null }))).toBe('Completed')
  })

  it('uses the error for failed and interrupted jobs', () => {
    expect(jobResultText(makeJob({ status: 'failed', error: '3 bad block(s) found' }))).toBe('3 bad block(s) found')
    expect(jobResultText(makeJob({ status: 'interrupted', error: 'Drive not present after restart' })))
      .toBe('Drive not present after restart')
  })

  it('has a fixed text for cancelled and queued jobs, and the progress message while running', () => {
    expect(jobResultText(makeJob({ status: 'cancelled' }))).toBe('Cancelled before it finished')
    expect(jobResultText(makeJob({ status: 'queued' }))).toBe('Waiting to start')
    expect(jobResultText(makeJob({
      status: 'running', progress: { percent: 40, message: 'pass 1/1 · 0x55 write · 40.0%', eta_seconds: null },
    }))).toBe('pass 1/1 · 0x55 write · 40.0%')
  })
})

describe('JobDetails — common properties', () => {
  const completed = makeJob({
    status: 'completed', summary: 'Self-test: Completed',
    created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:01Z', finished_at: '2026-01-01T00:02:07Z',
    result: { device: '/dev/sdb', test_type: 'short', result: 'Completed' },
  })

  it('shows status, result, times, duration and device for every job', () => {
    render(<JobDetails job={completed} />)
    expect(valueOf('Status')).toBe('Completed')
    expect(valueOf('Result')).toBe('Self-test: Completed')
    expect(screen.getByText('Started')).toBeInTheDocument()
    expect(screen.getByText('Finished')).toBeInTheDocument()
    expect(valueOf('Duration')).toBe('2m 6s')
    expect(valueOf('Device')).toBe('/dev/sdb')
  })

  it('shows when a job was queued, until it starts', () => {
    render(<JobDetails job={makeJob({ status: 'queued' })} />)
    expect(valueOf('Status')).toBe('Queued')
    expect(screen.getByText('Queued at')).toBeInTheDocument()
    expect(screen.queryByText('Started')).not.toBeInTheDocument()
    expect(screen.queryByText('Duration')).not.toBeInTheDocument()
  })

  it('shows a queue wait only when it was noticeable', () => {
    const waited = makeJob({ created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:10:00Z' })
    render(<JobDetails job={waited} />)
    expect(valueOf('Waited')).toBe('10m 0s in queue')
  })

  it('does not repeat the device or the self-test result string under Details', () => {
    render(<JobDetails job={completed} />)
    const details = screen.getByText('Details').closest('section')!
    expect(within(details).getByText('Test type')).toBeInTheDocument()
    expect(within(details).queryByText('Device')).not.toBeInTheDocument()
    expect(within(details).queryByText('Result')).not.toBeInTheDocument()
  })
})

describe('JobDetails — result without a summary', () => {
  it('keeps the result string under Details when nothing summarized it', () => {
    render(<JobDetails job={makeJob({
      status: 'completed', summary: null, result: { device: '/dev/sdb', result: 'Completed' },
    })} />)
    const details = screen.getByText('Details').closest('section')!
    const row = within(details).getByText('Result').closest('.job-detail-row')!
    expect(row.querySelector('.job-detail-value')).toHaveTextContent('Completed')
  })
})

describe('JobDetails — settings', () => {
  it('lists settings under their Run Task labels, with booleans as Yes/No', () => {
    render(<JobDetails job={makeJob({
      settings: [
        { name: 'duration', label: 'Duration (seconds)', value: 1000 },
        { name: 'fail', label: 'Fail partway through', value: false },
      ],
    })} />)
    expect(valueOf('Duration (seconds)')).toBe('1,000')
    expect(valueOf('Fail partway through')).toBe('No')
  })

  it('falls back to a humanized name when a setting has no label', () => {
    render(<JobDetails job={makeJob({ settings: [{ name: 'block_size', label: null, value: 4096 }] })} />)
    expect(valueOf('Block size')).toBe('4,096')
  })

  it('says so when an operation has no settings', () => {
    render(<JobDetails job={makeJob({ settings: [] })} />)
    expect(screen.getByText('No settings')).toBeInTheDocument()
  })

  it('keeps settings out of the result (they used to be mixed together)', () => {
    render(<JobDetails job={makeJob({
      status: 'completed', summary: 'Slept 40s', result: { slept_seconds: 40 },
      settings: [{ name: 'fail', label: 'Fail partway through', value: false }],
    })} />)
    const settings = screen.getByText('Settings').closest('section')!
    expect(within(settings).getByText('Fail partway through')).toBeInTheDocument()
    expect(within(settings).queryByText('Slept seconds')).not.toBeInTheDocument()
  })
})

describe('JobDetailRows (narrow popover)', () => {
  it('shows the common properties and settings, without the SMART panel', () => {
    render(<JobDetailRows job={makeJob({
      status: 'running', started_at: '2026-01-01T00:00:00Z',
      settings: [{ name: 'passes', label: 'Write/read passes', value: 1 }],
    })} />)
    expect(valueOf('Status')).toBe('Running')
    expect(valueOf('Write/read passes')).toBe('1')
    expect(screen.queryByText(/SMART before/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// SMART before/after
// ---------------------------------------------------------------------------

// Signals as recorded from a real failing SAS drive.
const SAS_SIGNALS = {
  power_on_hours: 51327, temp: 33, reallocated: 1028, pending: null, uncorrected: 0,
  crc_errors: null, reallocated_events: null, load_unload_cycles: 3272, smart_passed: false,
}

function snapshot(overrides: Partial<JobSmartSnapshot> = {}): JobSmartSnapshot {
  return {
    snapshot_id: 41, captured_at: '2026-11-11T01:11:18Z', signals: SAS_SIGNALS,
    health: { health_pct: 40, health_status: 'Failing' }, reused: false, ...overrides,
  }
}

function smart(
  before: JobSmartSnapshot | null, after: JobSmartSnapshot | null, worsened: string[] = [], uncompared: string[] = [],
): JobSmart {
  const changes: JobSmart['comparison'] = before?.signals && after?.signals
    ? {
        worsened,
        uncompared,
        changes: Object.fromEntries(Object.keys(before.signals).map(k => {
          const b = before.signals![k], a = after.signals![k]
          const numeric = typeof b === 'number' && typeof a === 'number'
          return [k, { before: b, after: a, change: numeric ? (a as number) - (b as number) : null }]
        })),
      }
    : null
  return { before, after, comparison: changes }
}

function row(label: string): HTMLElement {
  return screen.getByText(label).closest('tr') as HTMLElement
}

describe('JobSmartPanel', () => {
  it('compares before and after, skipping signals the drive does not report', () => {
    render(<JobSmartPanel job={makeJob({ status: 'completed', smart: smart(snapshot(), snapshot({ snapshot_id: 46 })) })} />)
    expect(within(row('Reallocated sectors')).getAllByText('1,028')).toHaveLength(2)
    expect(within(row('Power-on hours')).getAllByText('51,327h')).toHaveLength(2)
    expect(screen.queryByText('Pending sectors')).not.toBeInTheDocument()  // null on SAS
    expect(screen.getByText('No error counters increased during this run')).toBeInTheDocument()
  })

  it('marks values that are bad in themselves even when unchanged', () => {
    render(<JobSmartPanel job={makeJob({ status: 'completed', smart: smart(snapshot(), snapshot()) })} />)
    const statusCells = within(row('SMART status')).getAllByText('Failed')
    expect(statusCells.every(c => c.classList.contains('job-smart-bad'))).toBe(true)
    expect(within(row('Health score')).getAllByText('40 · Failing')[0]).toHaveClass('job-smart-bad')
  })

  it('calls out counters that got worse, with the change', () => {
    const after = snapshot({ signals: { ...SAS_SIGNALS, reallocated: 1032 } })
    render(<JobSmartPanel job={makeJob({ status: 'completed', smart: smart(snapshot(), after, ['reallocated']) })} />)
    expect(screen.getByText('Got worse during this run: Reallocated sectors +4')).toBeInTheDocument()
    expect(row('Reallocated sectors')).toHaveClass('job-smart-row-worse')
    expect(within(row('Reallocated sectors')).getByText('+4')).toBeInTheDocument()
  })

  it('does not claim a clean run when a counter was reported in only one snapshot', () => {
    const before = snapshot({ signals: { ...SAS_SIGNALS, reallocated: null } })
    render(<JobSmartPanel job={makeJob({ status: 'completed', smart: smart(before, snapshot(), [], ['reallocated']) })} />)
    expect(screen.getByText('Could not compare (reported in only one snapshot): Reallocated sectors')).toBeInTheDocument()
    expect(screen.queryByText(/No error counters increased/)).not.toBeInTheDocument()
  })

  it('names a worsened counter the table does not list', () => {
    render(<JobSmartPanel job={makeJob({ status: 'completed', smart: smart(snapshot(), snapshot(), ['media_errors']) })} />)
    expect(screen.getByText('Got worse during this run: Media errors')).toBeInTheDocument()
    expect(screen.queryByText(/No error counters increased/)).not.toBeInTheDocument()
  })

  it('notes a reused before-snapshot and links the full reports', () => {
    render(<JobSmartPanel job={makeJob({ id: 'job-9', status: 'completed', smart: smart(snapshot({ reused: true }), snapshot()) })} />)
    expect(screen.getByText(/reused a recent snapshot/)).toBeInTheDocument()
    expect(screen.getByText('Full SMART reports (JSON)')).toHaveAttribute('href', '/api/jobs/job-9/smart')
  })

  it('says the after-snapshot is pending while the job runs', () => {
    render(<JobSmartPanel job={makeJob({ status: 'running', smart: smart(snapshot(), null) })} />)
    expect(screen.getByText('After: taken when the job ends')).toBeInTheDocument()
    expect(screen.queryByText(/No error counters/)).not.toBeInTheDocument()
  })

  it('shows a failed capture instead of values', () => {
    const failed = { captured_at: '2026-11-11T01:14:24Z', error: 'smartctl timed out' }
    render(<JobSmartPanel job={makeJob({ status: 'completed', smart: smart(snapshot(), failed) })} />)
    expect(screen.getByText('After: capture failed — smartctl timed out')).toBeInTheDocument()
  })

  it('explains jobs without snapshots', () => {
    render(<JobSmartPanel job={makeJob({ status: 'completed' })} />)
    expect(screen.getByText('No SMART snapshots were recorded for this job.')).toBeInTheDocument()
  })
})
