import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import QueueTab, { JobRow } from './QueueTab'
import { makeDrive, makeJob } from './test/fixtures'

describe('QueueTab', () => {
  it('shows a stub message when there are no jobs', () => {
    render(<QueueTab drives={[]} jobs={[]} onCancel={vi.fn()} />)
    expect(screen.getByText('Queue')).toBeInTheDocument()
    expect(screen.getByText(/Running and queued jobs/)).toBeInTheDocument()
  })

  it('groups jobs into running, queued, and recently finished sections', () => {
    const jobs = [
      makeJob({ id: 'r1', status: 'running' }),
      makeJob({ id: 'q1', status: 'queued' }),
      makeJob({ id: 'c1', status: 'completed', finished_at: '2026-01-01T00:00:00Z' }),
    ]
    render(<QueueTab drives={[]} jobs={jobs} onCancel={vi.fn()} />)
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Recently finished')).toBeInTheDocument()
  })

  it('omits sections with no matching jobs', () => {
    render(<QueueTab drives={[]} jobs={[makeJob({ status: 'running' })]} onCancel={vi.fn()} />)
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
    expect(screen.queryByText('Recently finished')).not.toBeInTheDocument()
  })

  it('caps recently finished jobs at 15, newest first', () => {
    const jobs = Array.from({ length: 20 }, (_, i) =>
      makeJob({ id: `j${i}`, status: 'completed', finished_at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` }),
    )
    render(<QueueTab drives={[]} jobs={jobs} onCancel={vi.fn()} />)
    const section = screen.getByText('Recently finished').closest<HTMLElement>('.queue-section')!
    expect(within(section).getAllByText('Full Read Test')).toHaveLength(15)
  })
})

describe('JobRow', () => {
  it('shows a cancel button for running jobs and calls onCancel when clicked', async () => {
    const onCancel = vi.fn()
    render(<JobRow job={makeJob({ id: 'r1', status: 'running' })} drive={undefined} onCancel={onCancel} />)
    await userEvent.click(screen.getByTitle('Cancel'))
    expect(onCancel).toHaveBeenCalledWith('r1')
  })

  it('shows no cancel button for finished jobs', () => {
    render(<JobRow job={makeJob({ status: 'completed' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument()
  })

  it('shows the error message for failed jobs', () => {
    render(<JobRow job={makeJob({ status: 'failed', error: 'disk read error' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('disk read error')).toBeInTheDocument()
  })

  it('expands to show job details when clicked', async () => {
    render(<JobRow job={makeJob({ category: 'Scan' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.queryByText('Category')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Full Read Test'))
    expect(screen.getByText('Category')).toBeInTheDocument()
  })

  it('falls back to the raw guid when the drive is unknown', () => {
    render(<JobRow job={makeJob({ drive_guid: 'mystery-guid' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('mystery-guid')).toBeInTheDocument()
  })

  it('renders drive identity when the drive is known', () => {
    render(<JobRow job={makeJob()} drive={makeDrive({ model: 'ModelX' })} onCancel={vi.fn()} />)
    expect(screen.getByText('ModelX')).toBeInTheDocument()
  })
})
