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
  destructive: false,
  params: [{ name: 'blocksize', label: 'Block size', type: 'number', default: 4096, min: 512, max: 65536 }],
}

const SLEEP_DEBUG: OperationInfo = {
  key: 'debug_sleep',
  name: 'Sleep (debug)',
  category: 'Debug',
  tool: 'none',
  destructive: false,
  params: [{ name: 'fail', label: 'Fail partway through', type: 'boolean', default: false, min: null, max: null }],
}

const SECURE_ERASE: OperationInfo = {
  key: 'secure_erase',
  name: 'Secure Erase (shred)',
  category: 'Maintenance',
  tool: 'shred',
  destructive: true,
  params: [{ name: 'passes', label: 'Passes', type: 'number', default: 1, min: 1, max: 10 }],
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

  describe('destructive operations', () => {
    const DRIVES = [
      makeDrive({ guid: 'd1', label: 'Bay 3', model: 'Exos X16', serial: 'ZL2ABC01', block_device: '/dev/sdb', capacity_bytes: 16e12 }),
      makeDrive({ guid: 'd2', model: 'Ultrastar', serial: 'ZL2ABC02', block_device: '/dev/sdc', capacity_bytes: 6e12 }),
    ]

    async function renderErase(selected: string[], onRun = vi.fn().mockResolvedValue(undefined)) {
      vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([SECURE_ERASE]))
      render(<RunTaskTab drives={DRIVES} selected={selected} onRun={onRun} />)
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Secure Erase (shred)' })).toBeInTheDocument())
      await userEvent.click(screen.getByRole('button', { name: /^Run$/ }))
      return onRun
    }

    it('asks for confirmation instead of dispatching on Run', async () => {
      const onRun = await renderErase(['d1'])
      expect(onRun).not.toHaveBeenCalled()
      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toHaveTextContent('Secure Erase (shred) destroys all data on this drive')
      for (const text of ['Bay 3', 'Exos X16', 'ZL2ABC01', '/dev/sdb', '16 TB']) {
        expect(dialog).toHaveTextContent(text)
      }
    })

    it('dispatches once confirmed, naming the operation on the button', async () => {
      const onRun = await renderErase(['d1'])
      await userEvent.click(screen.getByRole('button', { name: 'Run Secure Erase (shred)' }))
      expect(onRun).toHaveBeenCalledWith(['d1'], 'secure_erase', { passes: 1 })
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    it('does nothing when cancelled, by button or Escape', async () => {
      const onRun = await renderErase(['d1'])
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: /^Run$/ }))
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(onRun).not.toHaveBeenCalled()
    })

    it('lists every target and requires the drive count to be typed for several drives', async () => {
      const onRun = await renderErase(['d1', 'd2'])
      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toHaveTextContent('these 2 drives')
      expect(dialog).toHaveTextContent('/dev/sdb')
      expect(dialog).toHaveTextContent('/dev/sdc')

      const confirm = screen.getByRole('button', { name: 'Run Secure Erase (shred)' })
      expect(confirm).toBeDisabled()
      await userEvent.type(screen.getByLabelText('Number of drives'), '3')
      expect(confirm).toBeDisabled()
      await userEvent.clear(screen.getByLabelText('Number of drives'))
      await userEvent.type(screen.getByLabelText('Number of drives'), '2')
      expect(confirm).toBeEnabled()
      await userEvent.click(confirm)
      expect(onRun).toHaveBeenCalledWith(['d1', 'd2'], 'secure_erase', { passes: 1 })
    })

    it('runs non-destructive operations without a dialog', async () => {
      const onRun = vi.fn().mockResolvedValue(undefined)
      vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
      render(<RunTaskTab drives={DRIVES} selected={['d1']} onRun={onRun} />)
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Full Read Test' })).toBeInTheDocument())
      await userEvent.click(screen.getByRole('button', { name: /^Run$/ }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(onRun).toHaveBeenCalled()
    })
  })

  describe('param tooltips', () => {
    const WITH_TIPS: OperationInfo = {
      ...SLEEP_DEBUG,
      params: [
        { name: 'duration', label: 'Duration (seconds)', type: 'number', default: 10, min: 1, max: 120, tooltip: 'How long the job runs.' },
        { name: 'fail', label: 'Fail partway through', type: 'boolean', default: false, min: null, max: null, tooltip: 'Fail halfway.' },
      ],
    }

    async function renderTips() {
      vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([WITH_TIPS]))
      render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Duration (seconds)')).toBeInTheDocument())
    }

    it('shows a param tooltip on hover', async () => {
      await renderTips()
      expect(screen.queryByText('How long the job runs.')).not.toBeInTheDocument()
      await userEvent.hover(screen.getByLabelText('About Duration (seconds)'))
      expect(screen.getByText('How long the job runs.')).toBeInTheDocument()
      await userEvent.unhover(screen.getByLabelText('About Duration (seconds)'))
      expect(screen.queryByText('How long the job runs.')).not.toBeInTheDocument()
    })

    it("tapping a boolean param's tooltip doesn't toggle its checkbox", async () => {
      await renderTips()
      await userEvent.click(screen.getByLabelText('About Fail partway through'))
      expect(screen.getByText('Fail halfway.')).toBeInTheDocument()
      expect(screen.getByRole('checkbox')).not.toBeChecked()
    })

    it('shows no icon for a param without a tooltip', async () => {
      vi.mocked(fetch).mockResolvedValue(fetchJsonResponse([READ_TEST]))
      render(<RunTaskTab drives={[makeDrive({ guid: 'd1' })]} selected={['d1']} onRun={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Block size')).toBeInTheDocument())
      expect(screen.queryByLabelText(/^About /)).not.toBeInTheDocument()
    })
  })
})
