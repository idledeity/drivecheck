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
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('switches to the SMART attributes sub-tab and fetches data for it', async () => {
    render(<HealthTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await userEvent.click(screen.getByRole('button', { name: 'SMART attributes' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/drives/d1/raw/latest'))
  })

  it('switches to the report sub-tab, which is a stub', async () => {
    render(<HealthTab drives={[]} selectedGuids={[]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByText(/Identity · verdict/)).toBeInTheDocument()
  })

  it('marks the active sub-tab button', async () => {
    render(<HealthTab drives={[]} selectedGuids={[]} />)
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveClass('active')
    await userEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('button', { name: 'Report' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveClass('active')
  })
})
