import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HealthTab from './HealthTab'
import { fetchJsonResponse, makeDrive } from './test/fixtures'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchJsonResponse({ raw: {} })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HealthTab', () => {
  it('defaults to the overview sub-tab without fetching anything', () => {
    render(<HealthTab drives={[]} selectedGuids={[]} />)
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveClass('active')
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows health score and flagged signals for a selected drive', () => {
    const drive = makeDrive({
      guid: 'd1',
      health_pct: 85,
      health_status: 'Degraded',
      signal_flags: { reallocated: 'warn', temp: 'ok' },
      reallocated: 3,
    })
    render(<HealthTab drives={[drive]} selectedGuids={['d1']} />)
    expect(screen.getByText('85')).toBeInTheDocument()
    expect(screen.getByText('Degraded')).toBeInTheDocument()
    expect(screen.getByText(/Realloc/)).toBeInTheDocument()
  })

  it('shows "No flagged signals" when all signals are ok', () => {
    const drive = makeDrive({ guid: 'd1', health_pct: 100, health_status: 'Healthy' })
    render(<HealthTab drives={[drive]} selectedGuids={['d1']} />)
    expect(screen.getByText('No flagged signals')).toBeInTheDocument()
  })

  it('fetches SMART data for selected drives when report tab is opened', async () => {
    render(<HealthTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/drives/d1/raw/latest'))
  })

  it('switches to the report sub-tab and shows download button', async () => {
    const drive = makeDrive({ guid: 'd1' })
    render(<HealthTab drives={[drive]} selectedGuids={['d1']} />)
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('button', { name: 'Download report' })).toBeInTheDocument()
  })

  it('dates the overview with its SMART read', () => {
    const drive = makeDrive({ guid: 'd1', last_polled_at: new Date(Date.now() - 20 * 60_000).toISOString() })
    render(<HealthTab drives={[drive]} selectedGuids={['d1']} />)
    expect(screen.getByText('20m ago').closest('.hov-asof')).toHaveTextContent('SMART read 20m ago')
  })

  it('report: dates the health and signal sections, and lists both read times', async () => {
    const drive = makeDrive({
      guid: 'd1',
      last_polled_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      last_full_read_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    })
    render(<HealthTab drives={[drive]} selectedGuids={['d1']} />)
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('heading', { name: 'Health20m ago' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Signals20m ago' })).toBeInTheDocument()
    expect(screen.getByText('Last SMART read')).toBeInTheDocument()
    expect(screen.getByText('Last full read')).toBeInTheDocument()
  })

  it('marks the active sub-tab button', async () => {
    render(<HealthTab drives={[]} selectedGuids={[]} />)
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveClass('active')
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('button', { name: 'Report' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveClass('active')
  })
})
