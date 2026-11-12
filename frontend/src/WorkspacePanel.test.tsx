import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePanel from './WorkspacePanel'
import { fetchJsonResponse, makeJob } from './test/fixtures'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchJsonResponse([])))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPanel(props: Partial<React.ComponentProps<typeof WorkspacePanel>> = {}) {
  return render(
    <WorkspacePanel drives={[]} selected={[]} jobs={[]} onCancelJob={vi.fn()} onMoveJob={vi.fn()} onRunOperation={vi.fn()}
      jobsSeenAt={null} onMarkJobsSeen={vi.fn()} {...props} />,
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

  it('counts finished jobs since the seen time on the Tasks and Activity tabs', async () => {
    const done = makeJob({ id: 'new', status: 'completed', finished_at: '2026-11-11T10:00:00' })
    const before = makeJob({ id: 'old', status: 'completed', finished_at: '2026-11-11T08:00:00' })
    renderPanel({ jobs: [done, before], jobsSeenAt: '2026-11-11T09:00:00' })
    const tasks = screen.getByRole('button', { name: /Tasks/ })
    expect(tasks).toHaveTextContent('Tasks1')
    await userEvent.click(tasks)
    expect(screen.getByRole('button', { name: /Activity/ })).toHaveTextContent('Activity1')
  })
})
