import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunTaskDialog from './RunTaskDialog'
import { JobsContext } from './jobsContext'
import { fetchJsonResponse, makeDrive } from './test/fixtures'
import type { OperationInfo } from './types'

const READ_TEST: OperationInfo = {
  key: 'dd_read_test', name: 'Full Read Test', category: 'Scan', tool: 'dd', destructive: false, params: [],
}
const SECURE_ERASE: OperationInfo = {
  key: 'secure_erase', name: 'Secure Erase (shred)', category: 'Maintenance', tool: 'shred', destructive: true, params: [],
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

async function setup(ops: OperationInfo[], runResult: string | null = null, guids = ['d1']) {
  vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(ops))
  const runOperation = vi.fn().mockResolvedValue(runResult)
  const onClose = vi.fn()
  render(
    <JobsContext.Provider value={{ jobs: [], unseen: [], cancelJob: vi.fn(), moveJob: vi.fn(), runOperation, markJobsSeen: vi.fn() }}>
      <RunTaskDialog drives={guids.map(guid => makeDrive({ guid }))} guids={guids} onClose={onClose} />
    </JobsContext.Provider>,
  )
  await screen.findByRole('heading', { name: ops[0].name })
  return { runOperation, onClose }
}

describe('RunTaskDialog', () => {
  it("offers the operations for the menu's drives", async () => {
    await setup([READ_TEST], null, ['d1', 'd2'])
    expect(fetch).toHaveBeenCalledWith('/api/operations?guids=d1%2Cd2')
    expect(screen.getByRole('dialog', { name: 'Run task on 2 drives' })).toBeInTheDocument()
  })

  it('runs the task on those drives and closes once it is queued', async () => {
    const { runOperation, onClose } = await setup([READ_TEST])
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(runOperation).toHaveBeenCalledWith(['d1'], 'dd_read_test', {})
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('stays open with the reason when the run is refused', async () => {
    const { onClose } = await setup([READ_TEST], 'Drive is busy')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Drive is busy')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape, the × and a backdrop click', async () => {
    const { onClose } = await setup([READ_TEST])
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(3)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it("leaves Escape and backdrop clicks to the destructive confirm while it's up", async () => {
    const { onClose } = await setup([SECURE_ERASE])
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const confirm = screen.getByRole('alertdialog')
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByRole('alertdialog').parentElement!)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
