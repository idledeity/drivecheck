import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JobRow } from './JobRow'
import ConfirmProvider from './ConfirmProvider'
import { makeDrive, makeJob } from './test/fixtures'

describe('JobRow', () => {
  it('shows a cancel button for running jobs, and cancels once confirmed in the pop-up', async () => {
    const onCancel = vi.fn()
    render(<ConfirmProvider><JobRow job={makeJob({ id: 'r1', status: 'running', operation_name: 'Badblocks' })} drive={undefined} onCancel={onCancel} /></ConfirmProvider>)
    await userEvent.click(screen.getByTitle('Cancel'))
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Cancel Badblocks?')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    expect(onCancel).toHaveBeenCalledWith('r1')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('cancels a queued job straight away', async () => {
    const onCancel = vi.fn()
    render(<ConfirmProvider><JobRow job={makeJob({ id: 'q1', status: 'queued' })} drive={undefined} onCancel={onCancel} /></ConfirmProvider>)
    await userEvent.click(screen.getByTitle('Cancel'))
    expect(onCancel).toHaveBeenCalledWith('q1')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('keeps the job, and leaves the row collapsed, on Keep running', async () => {
    const onCancel = vi.fn()
    render(<ConfirmProvider><JobRow job={makeJob({ status: 'running', category: 'Scan' })} drive={undefined} onCancel={onCancel} /></ConfirmProvider>)
    await userEvent.click(screen.getByTitle('Cancel'))
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
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
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Full Read Test'))
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  it('falls back to the raw guid when the drive is unknown', () => {
    render(<JobRow job={makeJob({ drive_guid: 'mystery-guid' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('mystery-guid')).toBeInTheDocument()
  })

  it('renders drive identity when the drive is known', () => {
    render(<JobRow job={makeJob()} drive={makeDrive({ model: 'ModelX' })} onCancel={vi.fn()} />)
    expect(screen.getByText('ModelX')).toBeInTheDocument()
  })

  it('shows the outcome of a finished job and how long it ran', () => {
    render(<JobRow job={makeJob({ status: 'completed', summary: 'Self-test: Completed', started_at: '2026-11-11T08:00:00', finished_at: '2026-11-11T10:14:00' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('Self-test: Completed')).toHaveClass('queue-outcome')
    expect(screen.getByTitle('Ran for 2h 14m')).toHaveTextContent(/^2h 14m · /)
  })

  it('marks failures red and says what a cancelled job did', () => {
    const { rerender } = render(<JobRow job={makeJob({ status: 'failed', error: 'disk read error' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('disk read error')).toHaveClass('queue-outcome', 'bad')
    rerender(<JobRow job={makeJob({ status: 'cancelled' })} drive={undefined} onCancel={vi.fn()} />)
    expect(screen.getByText('Cancelled before it finished')).not.toHaveClass('bad')
  })

  it('shows no outcome line while a job is running or queued', () => {
    render(<JobRow job={makeJob({ status: 'queued' })} drive={undefined} onCancel={vi.fn()} />)
    expect(document.querySelector('.queue-outcome')).toBeNull()
  })
})
