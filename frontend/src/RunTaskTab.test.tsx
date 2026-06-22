import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunTaskTab from './RunTaskTab'
import { fetchJsonResponse, makeDrive } from './test/fixtures'
import type { OperationInfo } from './types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const READ_TEST: OperationInfo = {
  key: 'dd_read_test',
  name: 'Full Read Test',
  category: 'Scan',
  tool: 'dd',
  params: [{ name: 'blocksize', label: 'Block size', type: 'number', default: 4096, min: 512, max: 65536 }],
}

const SLEEP_DEBUG: OperationInfo = {
  key: 'debug_sleep',
  name: 'Sleep (debug)',
  category: 'Debug',
  tool: 'none',
  params: [{ name: 'fail', label: 'Fail partway through', type: 'boolean', default: false, min: null, max: null }],
}

describe('RunTaskTab', () => {
  it('prompts for a selection when no drive is selected', () => {
    render(<RunTaskTab drives={[]} selected={[]} onRun={vi.fn()} />)
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
  })

  it('does not fetch operations when nothing is selected', () => {
    render(<RunTaskTab drives={[]} selected={[]} onRun={vi.fn()} />)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches operations for the selected drives and shows a stub when none are available', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
    expect(fetch).toHaveBeenCalledWith('/api/operations?guids=d1')
    await waitFor(() => expect(screen.getByText(/No operations available/)).toBeInTheDocument())
  })

  it('renders categories and operations, defaulting to the first operation', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Scan')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Full Read Test' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Full Read Test' })).toBeInTheDocument()
  })

  it('renders a number param input seeded with its default', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Block size')).toBeInTheDocument())
    expect(screen.getByRole('spinbutton')).toHaveValue(4096)
  })

  it('renders a boolean param input seeded with its default', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([SLEEP_DEBUG]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Fail partway through')).toBeInTheDocument())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('shows the single drive name as the target when one drive is selected', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1', model: 'ModelX' })]} selected={['d1']} onRun={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Target: ModelX')).toBeInTheDocument())
  })

  it('shows a drive count as the target when multiple drives are selected', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
    render(<RunTaskTab
      drives={[makeDrive({ guid: 'd1' }), makeDrive({ guid: 'd2' })]}
      selected={['d1', 'd2']}
      onRun={vi.fn()}
    />)
    await waitFor(() => expect(screen.getByText('Target: 2 drives')).toBeInTheDocument())
  })

  it('switches the active operation when another sidebar entry is clicked', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST, SLEEP_DEBUG]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Sleep (debug)')).toBeInTheDocument())

    await userEvent.click(screen.getByText('Sleep (debug)'))
    expect(screen.getByRole('heading', { name: 'Sleep (debug)' })).toBeInTheDocument()
  })

  it('calls onRun with the selected drives, operation key, and current params', async () => {
    const onRun = vi.fn().mockResolvedValue(undefined)
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
    render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={onRun} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Full Read Test' })).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect(onRun).toHaveBeenCalledWith(['d1'], 'dd_read_test', { blocksize: 4096 })
  })
})
