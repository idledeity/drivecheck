import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportTab from './ReportTab'
import { fetchJsonResponse, makeDrive } from './test/fixtures'

const detail = {
  captured_at: '2026-11-25T10:00:00+00:00', probe: 'smartctl_telemetry', detail: null, self_test_log: [],
  signals: { reallocated: 0, smart_passed: true }, signal_flags: {},
  health: { health_pct: 100, health_status: 'Healthy', factors: [], floor: null },
}
const info = { d1: { groups: [{ id: 'identity', title: 'Identity', as_of: null,
  rows: [{ key: 'firmware', label: 'Firmware', value: 'SN03', format: 'text' }] }] } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(fetchJsonResponse(
    url.startsWith('/api/drives/info') ? info : url.startsWith('/api/jobs/history') ? [] : detail))))
})
afterEach(() => vi.unstubAllGlobals())

describe('ReportTab', () => {
  it('asks for a selection when none is made', () => {
    render(<ReportTab drives={[]} selectedGuids={[]} />)
    expect(screen.getByText('Select one or more drives to see their report.')).toBeInTheDocument()
  })

  it('renders each section, with the full SMART read collapsed, and enables the exports once loaded', async () => {
    render(<ReportTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    expect(await screen.findByText(/^Healthy \(100\/100\)\. No sign of trouble/)).toBeInTheDocument()
    expect(await screen.findByText('SN03')).toBeInTheDocument()
    for (const title of ['Verdict', 'Drive details', 'Health', 'Testing', 'Full SMART read']) {
      expect(screen.getAllByText(title, { selector: 'summary' })).toHaveLength(1)
    }
    expect(screen.getByText('Full SMART read', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Verdict', { selector: 'summary' }).closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Download HTML' })).toBeEnabled()
  })

  it('jumps to a section from its contents link, opening it', async () => {
    render(<ReportTab drives={[makeDrive({ guid: 'd1' })]} selectedGuids={['d1']} />)
    await screen.findByText(/^Healthy \(100\/100\)/)
    Element.prototype.scrollIntoView = vi.fn()
    await userEvent.click(screen.getByRole('link', { name: 'Full SMART read' }))
    expect(screen.getByText('Full SMART read', { selector: 'summary' }).closest('details')).toHaveAttribute('open')
  })
})
