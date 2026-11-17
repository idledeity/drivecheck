import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SmartPanel, { SmartSummary } from './SmartPage'
import { formatBytes, formatFieldValue } from './smartDetail'
import { fetchJsonResponse, makeDrive } from './test/fixtures'
import type { SmartDetailResponse, SmartField } from './types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function field(overrides: Partial<SmartField>): SmartField {
  return {
    key: 'k', label: 'Label', value: 0, unit: 'count', status: 'ok', source: null,
    detail: null, limit: null, attribute_id: null, ...overrides,
  }
}

function response(overrides: Partial<SmartDetailResponse['detail'] & object> = {}): SmartDetailResponse {
  return {
    captured_at: '2026-01-01T00:00:00Z',
    probe: 'smartctl_telemetry',
    self_test_log: [],
    detail: {
      protocol: 'ATA',
      groups: [{
        key: 'media', label: 'Media errors', fields: [
          field({ key: 'reallocated_sectors', label: 'Reallocated sectors', value: 8, status: 'warn', source: 'ATA 5', attribute_id: 5 }),
          field({ key: 'pending_sectors', label: 'Pending sectors', value: 0, source: 'ATA 197', attribute_id: 197 }),
        ],
      }],
      attributes: [
        { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, margin: 90, type: 'Pre-fail',
          updated: 'Always', flags: 'PO--CK', raw_value: 8, raw_string: '8', when_failed: null, status: 'warn' },
        { id: 180, name: 'Unknown_HDD_Attribute', value: 90, worst: 90, thresh: 100, margin: -10, type: 'Pre-fail',
          updated: 'Always', flags: 'POSR-K', raw_value: 0, raw_string: '0', when_failed: null, status: 'crit' },
        { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, margin: null, type: 'Old-age',
          updated: 'Always', flags: '-O--C-', raw_value: 0, raw_string: '0', when_failed: null, status: 'ok' },
      ],
      other_fields: [{ path: 'model_family', value: 'Seagate Exos X16' }],
      ...overrides,
    },
  }
}

describe('SmartPanel', () => {
  it('prompts for a selection when no drive is selected', () => {
    render(<SmartPanel drives={[]} selectedGuids={[]} />)
    expect(screen.getByText(/Select one or more drives/)).toBeInTheDocument()
  })

  it('shows named fields with their source and the attribute columns behind them', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response()))
    render(<SmartPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    expect(fetch).toHaveBeenCalledWith('/api/drives/d1/smart/detail')
    const label = await screen.findByText('Reallocated sectors')
    const row = label.closest('.smart-field') as HTMLElement
    expect(within(row).getByText('8')).toHaveClass('smart-warn')
    expect(within(row).getByText('ATA 5')).toBeInTheDocument()
    expect(within(row).getByText('value 100 · worst 100 · thresh 10')).toBeInTheDocument()
  })

  it('lists every attribute in the full table, vendor-specific ones included', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response()))
    render(<SmartPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    expect(await screen.findByText('All SMART attributes (3)')).toBeInTheDocument()
    const table = document.querySelector('.smart-attr-table') as HTMLElement
    const unknown = within(table).getByText('Unknown HDD Attribute').closest('tr') as HTMLElement
    expect(unknown).toHaveClass('smart-row-crit')
    expect(within(unknown).getByText('-10')).toBeInTheDocument()      // margin below threshold
  })

  it('keeps everything else smartctl reported behind a disclosure', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response()))
    render(<SmartPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    const summary = await screen.findByText('Everything else smartctl reported (1)')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('model_family')).toBeInTheDocument()
  })

  it('says when the values were read', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response()))
    render(<SmartPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    const time = await screen.findByText(/ago$/)
    expect(time.closest('.smart-asof')).toHaveTextContent(/^Full SMART read \d+d ago$/)
  })

  it('shows the SAS error counter grid', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response({
      protocol: 'SCSI', attributes: undefined,
      scsi_error_counters: {
        columns: [{ key: 'errors_corrected_by_eccfast', label: 'ECC fast' }, { key: 'total_uncorrected_errors', label: 'Uncorrected' }],
        rows: [
          { direction: 'read', errors_corrected_by_eccfast: 2748721516, total_uncorrected_errors: 7 },
          { direction: 'write', errors_corrected_by_eccfast: 0, total_uncorrected_errors: 0 },
        ],
      },
    })))
    render(<SmartPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    const read = (await screen.findByText('Read')).closest('tr') as HTMLElement
    expect(within(read).getByText('7')).toHaveClass('smart-crit')
    expect(within(read).getByText((2748721516).toLocaleString())).not.toHaveClass('smart-crit')
  })

  it('says there is no SMART data when the read holds none, showing nothing from elsewhere', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse({ ...response(), detail: null }))
    render(<SmartPanel drives={[makeDrive({ guid: 'd1', temp: 40 })]} selectedGuids={['d1']} />)
    expect(await screen.findByText('No SMART data for this drive.')).toBeInTheDocument()
  })

  it('says there is no SMART data when the drive has never been read', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => null } as Response)
    render(<SmartPanel drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    expect(await screen.findByText('No SMART data for this drive.')).toBeInTheDocument()
  })
})

describe('SmartSummary', () => {
  it('lists only values that are not ok, plus attributes not behind a listed field', async () => {
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response()))
    render(<SmartSummary guid="d1" onOpenSmart={() => {}} />)
    expect(await screen.findByText('Reallocated sectors')).toBeInTheDocument()
    expect(screen.getByText('Unknown HDD Attribute')).toBeInTheDocument()
    expect(screen.queryByText('Pending sectors')).not.toBeInTheDocument()
    expect(screen.queryByText('Reallocated Sector Ct')).not.toBeInTheDocument()   // already shown as a field
  })

  it('says so when everything is within limits, and links to the SMART page', async () => {
    const onOpenSmart = vi.fn()
    vi.mocked(fetch).mockResolvedValue(fetchJsonResponse(response({
      groups: [{ key: 'media', label: 'Media errors', fields: [field({ label: 'Pending sectors' })] }],
      attributes: [],
    })))
    render(<SmartSummary guid="d1" onOpenSmart={onOpenSmart} />)
    expect(await screen.findByText('Every SMART value is within limits.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'All SMART data →' }))
    expect(onOpenSmart).toHaveBeenCalled()
  })
})

describe('formatting', () => {
  it('formats values by unit', () => {
    expect(formatFieldValue({ value: 20652, unit: 'hours' })).toBe(`${(20652).toLocaleString()} h`)
    expect(formatFieldValue({ value: 1286, unit: 'minutes' })).toBe('21h 26m')
    expect(formatFieldValue({ value: 2, unit: 'minutes' })).toBe('2 min')
    expect(formatFieldValue({ value: '27 / 32', unit: 'celsius' })).toBe('27 / 32 °C')
    expect(formatFieldValue({ value: true, unit: null })).toBe('yes')
    expect(formatFieldValue({ value: null, unit: 'count' })).toBe('—')
  })

  it('formats bytes with one decimal below 100 units', () => {
    expect(formatBytes(70_700_405_950_464)).toBe('70.7 TB')
    expect(formatBytes(333_494_563_000_000)).toBe('333 TB')
    expect(formatBytes(113_202_412_032)).toBe('113 GB')
  })
})
