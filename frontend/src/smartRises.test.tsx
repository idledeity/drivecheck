import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JobRow } from './JobRow'
import { BatchRow } from './BatchRow'
import ConfirmProvider from './ConfirmProvider'
import { makeJob } from './test/fixtures'
import type { Job, JobBatch, JobSmart } from './types'

const snap = { captured_at: '2026-01-01T00:00:00Z', signals: {} }
const rose: NonNullable<JobSmart['comparison']> = {
  changes: { reallocated: { before: 12, after: 15, change: 3 }, pending: { before: 0, after: 1, change: 1 } },
  worsened: ['reallocated', 'pending'],
  uncompared: [],
}
const clean: NonNullable<JobSmart['comparison']> = { changes: { reallocated: { before: 12, after: 12, change: 0 } }, worsened: [], uncompared: [] }
const finished = (comparison: JobSmart['comparison'], smart: Partial<JobSmart> = { before: snap, after: snap }): Job =>
  makeJob({ status: 'completed', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T01:00:00Z', smart: { before: null, after: null, ...smart, comparison } })

describe('SMART rises on a job row', () => {
  it('leads the outcome with the counters that rose, full values on hover', () => {
    render(<JobRow job={finished(rose)} drive={undefined} onCancel={vi.fn()} />)
    const note = screen.getByText('+3 Realloc · +1 Pending')
    expect(note).toHaveClass('queue-smart', 'worse')
    expect(note).toHaveAttribute('title', 'Got worse during this run: Reallocated sectors 12 → 15, Pending sectors 0 → 1')
  })

  it('says nothing when no counter rose', () => {
    render(<JobRow job={finished(clean)} drive={undefined} onCancel={vi.fn()} />)
    expect(document.querySelector('.queue-smart')).toBeNull()
  })

  it('says SMART was not compared when a snapshot is missing, but not for jobs with no snapshots at all', () => {
    const { unmount } = render(<JobRow job={finished(null, { before: snap, after: null })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('SMART not compared')).not.toHaveClass('worse')
    unmount()
    render(<JobRow job={finished(null, {})} drive={undefined} onCancel={vi.fn()} />)
    expect(document.querySelector('.queue-smart')).toBeNull()
  })
})

describe('SMART across a batch', () => {
  const batch = (smart: JobBatch['smart'], step: number): JobBatch =>
    ({ id: 'b1', step, recipe: 'r', recipe_name: 'Stress', params: {}, stop_on_failure: false, smart })
  const steps = (smart: JobBatch['smart'], second: Partial<Job> = {}) => [
    { ...finished(clean), id: 's0', batch: batch(smart, 0) },
    { ...finished(clean), id: 's1', batch: batch(smart, 1), ...second },
  ]
  const renderBatch = (s: Job[]) => render(<ConfirmProvider><BatchRow steps={s} drive={undefined} onCancel={vi.fn()} onCancelBatch={vi.fn()} /></ConfirmProvider>)

  it('shows the change from the first step to the last under the strip', () => {
    renderBatch(steps({ ...rose, from_step: 0, to_step: 1 }))
    expect(document.querySelector('.batch-smart')).toHaveTextContent('SMART during batch: Reallocated sectors 12 → 15, Pending sectors 0 → 1')
    expect(document.querySelector('.batch-smart')).toHaveClass('worse')
  })

  it('says no counter rose once a clean batch is done', () => {
    renderBatch(steps({ ...clean, from_step: 0, to_step: 1 }))
    expect(document.querySelector('.batch-smart')).toHaveTextContent('SMART during batch: no error counters rose')
  })

  it('shows nothing while the first step is still running', () => {
    renderBatch([
      { ...makeJob({ id: 's0', status: 'running', started_at: '2026-01-01T00:00:00Z' }), batch: batch(null, 0) },
      { ...makeJob({ id: 's1', status: 'queued' }), batch: batch(null, 1) },
    ])
    expect(document.querySelector('.batch-smart')).toBeNull()
  })

  it('says "so far" while later steps are still to run', () => {
    renderBatch(steps({ ...rose, from_step: 0, to_step: 0 }, { status: 'running', finished_at: null }))
    expect(document.querySelector('.batch-smart')).toHaveTextContent(/^SMART so far: Reallocated sectors 12 → 15/)
  })
})
