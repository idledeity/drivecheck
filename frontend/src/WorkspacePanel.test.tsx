import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePanel from './WorkspacePanel'
import { JobsContext, type JobsContextValue } from './jobsContext'
import { fetchJsonResponse, makeJob } from './test/fixtures'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchJsonResponse([])))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPanel(jobs: Partial<JobsContextValue> = {}) {
  const value: JobsContextValue = {
    jobs: [], unseen: [], cancelJob: vi.fn(), moveJob: vi.fn(), runOperation: vi.fn(), markJobsSeen: vi.fn(), ...jobs,
  }
  return render(
    <JobsContext.Provider value={value}>
      <WorkspacePanel drives={[]} selected={[]} />
    </JobsContext.Provider>,
  )
}

describe('WorkspacePanel', () => {
  it('defaults to the Health tab, expanded', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: 'Health' })).toHaveClass('active')
    expect(screen.getByText(/Select one or more drives to view an overview/)).toBeInTheDocument()
  })

  it('collapses the body when the toggle is clicked', async () => {
    renderPanel()
    expect(screen.getByText(/Select one or more drives to view an overview/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse workspace panel' }))
    expect(screen.queryByText(/Select one or more drives to view an overview/)).not.toBeInTheDocument()
  })

  it('switches to the Activity tab', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Activity' }))
    expect(screen.getByRole('region', { name: 'Summary' })).toBeInTheDocument()
  })

  it('switches to the Run Task tab', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run Task' }))
    expect(screen.getByText(/Select one or more drives to configure/)).toBeInTheDocument()
  })

  it('switches to the History tab', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByRole('group', { name: 'Finished in' })).toBeInTheDocument()
  })

  it('shows the unseen-results count on the Tasks and Activity tabs', async () => {
    renderPanel({ unseen: [makeJob({ id: 'new', status: 'completed', finished_at: '2026-11-11T10:00:00' })] })
    const tasks = screen.getByRole('button', { name: /Tasks/ })
    expect(tasks).toHaveTextContent('Tasks1')
    await userEvent.click(tasks)
    expect(screen.getByRole('button', { name: /Activity/ })).toHaveTextContent('Activity1')
  })
})
