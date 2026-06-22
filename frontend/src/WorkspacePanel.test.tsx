import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePanel from './WorkspacePanel'
import { fetchJsonResponse } from './test/fixtures'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchJsonResponse([])))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPanel() {
  return render(
    <WorkspacePanel drives={[]} selected={[]} jobs={[]} onCancelJob={vi.fn()} onRunOperation={vi.fn()} />,
  )
}

describe('WorkspacePanel', () => {
  it('defaults to the Health tab, expanded', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: 'Health' })).toHaveClass('active')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('collapses the body when the toggle is clicked', async () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '' })) // the chevron toggle has no accessible name
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument()
  })

  it('switches to the Queue tab', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    expect(screen.getByText(/Running and queued jobs/)).toBeInTheDocument()
  })

  it('switches to the Run Task tab', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Run Task' }))
    expect(screen.getByText(/Select one or more drives to configure/)).toBeInTheDocument()
  })

  it('switches to the History tab', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByText(/Select one or more drives to view job history/)).toBeInTheDocument()
  })
})
