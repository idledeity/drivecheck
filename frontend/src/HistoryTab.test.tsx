import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HistoryTab from './HistoryTab'
import { fetchJsonResponse, makeDrive, makeJob } from './test/fixtures'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HistoryTab', () => {
  it('prompts for a selection when no drive is selected', () => {
    render(<HistoryTab drives={[]} selectedGuids={[]} />)
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
  })

  it('fetches and renders job history for each selected drive', async () => {
    const drive = makeDrive({ guid: 'd1', model: 'ModelX' })
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([makeJob({ id: 'j1' })]))

    render(<HistoryTab drives={[drive]} selectedGuids={['d1']} />)

    expect(fetch).toHaveBeenCalledWith('/api/jobs/history?guid=d1')
    // "ModelX" appears twice: once in DriveHistory's own header, once inside
    // the rendered JobRow's drive identity.
    await waitFor(() => expect(screen.getAllByText('ModelX').length).toBeGreaterThan(0))
    expect(screen.getByText('Full Read Test')).toBeInTheDocument()
  })

  it('shows an empty message when a drive has no completed jobs', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    render(<HistoryTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('No completed jobs for this drive yet.')).toBeInTheDocument())
  })

  it('treats a fetch failure the same as an empty history', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))
    render(<HistoryTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await waitFor(() => expect(screen.getByText('No completed jobs for this drive yet.')).toBeInTheDocument())
  })

  it('renders one section per selected drive', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    render(<HistoryTab
      drives={[makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]}
      selectedGuids={['d1', 'd2']}
    />)
    expect(fetch).toHaveBeenCalledWith('/api/jobs/history?guid=d1')
    expect(fetch).toHaveBeenCalledWith('/api/jobs/history?guid=d2')
  })
})
