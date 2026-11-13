import { fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DriveContextMenu from './DriveContextMenu'
import ConfirmProvider from './ConfirmProvider'
import { JobsContext } from './jobsContext'
import type { Job } from './types'
import { makeDrive, makeJob } from './test/fixtures'
import { copyText } from './clipboard'

vi.mock('./clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }))

function renderMenu(activeJobs: Job[], guids = ['guid-1'], drives = guids.map(guid => makeDrive({ guid }))) {
  const cancelJob = vi.fn()
  const onClose = vi.fn()
  render(
    <JobsContext.Provider value={{ jobs: [], unseen: [], cancelJob, moveJob: vi.fn(), runOperation: vi.fn(), markJobsSeen: vi.fn() }}>
      <ConfirmProvider>
        <DriveContextMenu
          pos={{ x: 10, y: 10 }}
          guids={guids}
          drives={drives}
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

describe('copy', () => {
  afterEach(() => { vi.useRealTimers(); vi.mocked(copyText).mockClear() })

  const drive = (guid: string, serial: string | null) => makeDrive({ guid, serial, device: `/dev/${guid}`, label: null })

  const openCopy = () => fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

  it('offers name, serial, device path and summary in a Copy submenu', () => {
    renderMenu([], ['a'], [drive('a', 'SER1')])
    expect(screen.queryByRole('button', { name: 'Serial' })).not.toBeInTheDocument()
    openCopy()
    for (const label of ['Name', 'Serial', 'Device path', 'Summary']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('copies, says so, then closes the menu', async () => {
    vi.useFakeTimers()
    const { onClose } = renderMenu([], ['a'], [drive('a', 'SER1')])
    openCopy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Serial' })) })
    expect(copyText).toHaveBeenCalledWith('SER1')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(600) })
    expect(onClose).toHaveBeenCalled()
  })

  it('says when the copy failed', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false)
    renderMenu([], ['a'], [drive('a', 'SER1')])
    openCopy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Serial' })) })
    expect(screen.getByRole('button', { name: "Couldn't copy" })).toBeInTheDocument()
  })

  it('copies one line per selected drive', async () => {
    renderMenu([], ['a', 'b'], [drive('a', 'SER1'), drive('b', 'SER2')])
    openCopy()
    expect(screen.getByText('One line per drive')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Device path' })) })
    expect(copyText).toHaveBeenCalledWith('/dev/a\n/dev/b')
  })

  it('leaves out Serial when no selected drive has one', () => {
    renderMenu([], ['a'], [drive('a', null)])
    openCopy()
    expect(screen.queryByRole('button', { name: 'Serial' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument()
  })
})

describe('closing', () => {
  it('closes on a page scroll but not on a scroll inside the menu', () => {
    const { onClose } = renderMenu([])
    fireEvent.scroll(document.querySelector('.dc-ctx-menu')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.scroll(window)
    expect(onClose).toHaveBeenCalled()
  })
})
