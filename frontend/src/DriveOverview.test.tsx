import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DriveOverview from './DriveOverview'
import { fetchJsonResponse, makeDrive } from './test/fixtures'

// The card's health popover (moved here from Health > Overview, now gone).

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchJsonResponse({})))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DriveOverview', () => {
  it('shows the health score and what made it for a selected drive', () => {
    const drive = makeDrive({
      guid: 'd1',
      health_pct: 69,
      health_status: 'Degraded',
      health_factors: [
        { key: 'reallocated', kind: 'media', label: 'Reallocated sectors', signal: 'reallocated', value: '10',
          standalone: 69, weight: 0.3, role: 'start', points: 69 },
        { key: 'power_on_hours', kind: 'wear', label: 'Power-on hours', signal: 'power_on_hours', value: '60,000 h',
          standalone: 93, weight: 0.2, role: 'adds', points: -0.03 },
      ],
    })
    render(<DriveOverview drive={drive} />)
    expect(screen.getByText('Degraded').closest('.health-badge')).toHaveTextContent('Degraded69')
    expect(screen.getByText('Reallocated sectors').closest('.hf')).toHaveTextContent(
      'Reallocated sectors1069Power-on hours60,000 h−<0.1')
  })

  it('says nothing lowers the score of a clean drive, and what Healthy means', async () => {
    const drive = makeDrive({ guid: 'd1', health_pct: 100, health_status: 'Healthy' })
    render(<DriveOverview drive={drive} />)
    expect(screen.getByText('Nothing lowers the score')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('About this health status'))
    expect(screen.getByText(/^Healthy: No sign of trouble/)).toBeInTheDocument()
  })

  it('says when age or wear alone held the score up', () => {
    const drive = makeDrive({
      guid: 'd1', health_pct: 80, health_status: 'Aging', health_floor: 80,
      health_factors: [{ key: 'power_on_hours', kind: 'wear', label: 'Power-on hours', signal: 'power_on_hours',
                         value: '200,000 h', standalone: 82, weight: 0.2, role: 'start', points: 82 }],
    })
    render(<DriveOverview drive={drive} />)
    expect(screen.getByText(/^Held at 80/)).toBeInTheDocument()
  })

  it('dates the overview with its SMART read', () => {
    const drive = makeDrive({ guid: 'd1', last_polled_at: new Date(Date.now() - 20 * 60_000).toISOString() })
    render(<DriveOverview drive={drive} />)
    expect(screen.getByText('20m ago').closest('.hov-asof')).toHaveTextContent('SMART read 20m ago')
  })
})
