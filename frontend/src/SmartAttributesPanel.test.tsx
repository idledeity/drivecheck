import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SmartAttributesPanel from './SmartAttributesPanel'
import { fetchJsonResponse, makeDrive } from './test/fixtures'
import type { RawSnapshot } from './types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function snapshot(overrides: Partial<RawSnapshot['raw']> = {}): RawSnapshot {
  return {
    captured_at: '2026-01-01T00:00:00Z',
    probe: 'smartctl',
    raw: { smart_attributes: [], self_test_log: [], ...overrides },
  }
}

describe('SmartAttributesPanel', () => {
  it('prompts for a selection when no drive is selected', () => {
    render(<SmartAttributesPanel drives={[]} selectedGuids={[]} />)
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
  })

  it('fetches and renders attribute rows for each selected drive', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(snapshot({
      smart_attributes: [{ key: 'temp', label: 'Temperature', value: '35°C', status: 'ok', detail: null }],
    })))
    render(<SmartAttributesPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    expect(fetch).toHaveBeenCalledWith('/api/drives/d1/raw/latest')
    await waitFor(() => expect(screen.getByText('Temperature')).toBeInTheDocument())
    expect(screen.getByText('35°C')).toBeInTheDocument()
  })

  it('sorts attribute rows by severity: crit, then warn, then ok', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(snapshot({
      smart_attributes: [
        { key: 'a', label: 'Ok One', value: '1', status: 'ok', detail: null },
        { key: 'b', label: 'Crit One', value: '2', status: 'crit', detail: null },
        { key: 'c', label: 'Warn One', value: '3', status: 'warn', detail: null },
      ],
    })))
    render(<SmartAttributesPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('Crit One')).toBeInTheDocument())

    const labels = screen.getAllByText(/One$/).map(el => el.textContent)
    expect(labels).toEqual(['Crit One', 'Warn One', 'Ok One'])
  })

  it('renders the self-test log under its own section title', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(snapshot({
      self_test_log: [{ key: 'ata_self_test_0', label: 'Short offline', value: 'Completed', status: 'ok', detail: null }],
    })))
    render(<SmartAttributesPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('Self-Test History (drive log)')).toBeInTheDocument())
    expect(screen.getByText('Short offline')).toBeInTheDocument()
  })

  it('shows a not-found message on a 404 response', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(null, 404))
    render(<SmartAttributesPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('No SMART data yet — waiting for next poll.')).toBeInTheDocument())
  })

  it('shows a not-found message when the fetch itself fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))
    render(<SmartAttributesPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('No SMART data yet — waiting for next poll.')).toBeInTheDocument())
  })

  it('shows an empty message when the snapshot has no attributes or self-test log', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(snapshot()))
    render(<SmartAttributesPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('No attribute data available for this drive.')).toBeInTheDocument())
  })
})
