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

  it('switches to the SMART attributes sub-tab and fetches data for it', async () => {
    render(<HealthTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await userEvent.click(screen.getByRole('button', { name: 'SMART attributes' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/drives/d1/raw/latest'))
  })

  it('switches to the report sub-tab and shows download button', async () => {
    const drive = makeDrive({ guid: 'd1' })
    render(<HealthTab drives={[drive]} selectedGuids={['d1']} />)
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('button', { name: 'Download report' })).toBeInTheDocument()
  })

  it('marks the active sub-tab button', async () => {
    render(<HealthTab drives={[]} selectedGuids={[]} />)
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveClass('active')
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('button', { name: 'Report' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveClass('active')
  })
})
