import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DriveContextMenu from './DriveContextMenu'
import ConfirmProvider from './ConfirmProvider'
import { JobsContext } from './jobsContext'
import type { Job } from './types'
import { makeDrive, makeJob } from './test/fixtures'

function renderMenu(activeJobs: Job[], guids = ['guid-1']) {
  const cancelJob = vi.fn()
  const onClose = vi.fn()
  render(
    <JobsContext.Provider value={{ jobs: [], unseen: [], cancelJob, moveJob: vi.fn(), runOperation: vi.fn(), markJobsSeen: vi.fn() }}>
      <ConfirmProvider>
        <DriveContextMenu
          pos={{ x: 10, y: 10 }}
          guids={guids}
          drives={guids.map(guid => makeDrive({ guid }))}
          onClose={onClose}
          onSetLocked={vi.fn()}
          activeJobs={activeJobs}
        />
      </ConfirmProvider>
    </JobsContext.Provider>,
  )
  return { cancelJob, onClose }
}

describe('cancel task', () => {
  it('is absent when no drive has an active task', () => {
    renderMenu([])
    expect(screen.queryByText(/Cancel/)).not.toBeInTheDocument()
  })

  it('closes the menu and asks in the pop-up before ending a running task', async () => {
    const { cancelJob, onClose } = renderMenu([makeJob({ id: 'j1', status: 'running', operation_name: 'Badblocks' })])
    fireEvent.click(screen.getByText('Cancel task'))
    expect(onClose).toHaveBeenCalled()
    expect(cancelJob).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Cancel Badblocks?')

    // The mock onClose leaves the menu up, so look in the pop-up only.
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel task' }))
    await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith('j1'))
  })

  it('keeps the task on Keep running', async () => {
    const { cancelJob } = renderMenu([makeJob({ id: 'j1', status: 'running' })])
    fireEvent.click(screen.getByText('Cancel task'))
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    await Promise.resolve()
    expect(cancelJob).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('cancels a task that has not started without asking', () => {
    const { cancelJob } = renderMenu([makeJob({ id: 'j1', status: 'queued' })])
    fireEvent.click(screen.getByText('Cancel task'))
    expect(cancelJob).toHaveBeenCalledWith('j1')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it("cancels every selected drive's active task once confirmed", async () => {
    const { cancelJob } = renderMenu(
      [makeJob({ id: 'j1', status: 'running' }), makeJob({ id: 'j2', drive_guid: 'guid-2', status: 'queued' })],
      ['guid-1', 'guid-2', 'guid-3'],
    )
    fireEvent.click(screen.getByText('Cancel 2 tasks'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Cancel 2 tasks?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel tasks' }))
    await vi.waitFor(() => expect(cancelJob.mock.calls).toEqual([['j1'], ['j2']]))
  })
})
