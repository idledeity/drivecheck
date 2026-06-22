import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GridControls from './GridControls'
import { makeDrive } from './test/fixtures'

function renderControls(overrides: Partial<Parameters<typeof GridControls>[0]> = {}) {
  const props = {
    drives: [makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })],
    selected: [],
    onSelectAll: vi.fn(),
    onUnselectAll: vi.fn(),
    onProbe: vi.fn().mockResolvedValue(undefined),
    onScan: vi.fn().mockResolvedValue(undefined),
    onOpenSettings: vi.fn(),
    ...overrides,
  }
  render(<GridControls {...props} />)
  return props
}

describe('GridControls', () => {
  it('calls onSelectAll when clicked', async () => {
    const props = renderControls()
    await userEvent.click(screen.getByTitle('Select all drives'))
    expect(props.onSelectAll).toHaveBeenCalledOnce()
  })

  it('disables select all when every drive is already selected', () => {
    renderControls({ selected: ['d1', 'd2'] })
    expect(screen.getByTitle('Select all drives')).toBeDisabled()
  })

  it('disables unselect all when nothing is selected', () => {
    renderControls({ selected: [] })
    expect(screen.getByTitle('Clear selection')).toBeDisabled()
  })

  it('calls onUnselectAll when enabled and clicked', async () => {
    const props = renderControls({ selected: ['d1'] })
    await userEvent.click(screen.getByTitle('Clear selection'))
    expect(props.onUnselectAll).toHaveBeenCalledOnce()
  })

  it('shows a generic probe label with no selection', () => {
    renderControls({ selected: [] })
    expect(screen.getByTitle('Probe all drives')).toBeInTheDocument()
  })

  it('shows a counted probe label when drives are selected', () => {
    renderControls({ selected: ['d1', 'd2'] })
    expect(screen.getByTitle('Probe selected (2)')).toBeInTheDocument()
  })

  it('calls onProbe when the probe button is clicked', async () => {
    const props = renderControls()
    await userEvent.click(screen.getByTitle('Probe all drives'))
    expect(props.onProbe).toHaveBeenCalledOnce()
  })

  it('calls onScan when the scan button is clicked', async () => {
    const props = renderControls()
    await userEvent.click(screen.getByTitle('Scan for drives'))
    expect(props.onScan).toHaveBeenCalledOnce()
  })

  it('calls onOpenSettings when the settings button is clicked', async () => {
    const props = renderControls()
    await userEvent.click(screen.getByTitle('Settings'))
    expect(props.onOpenSettings).toHaveBeenCalledOnce()
  })
})
