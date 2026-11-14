import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DriveChip, { DriveChipHeader } from './DriveChip'
import { makeDrive } from './test/fixtures'

describe('DriveChip', () => {
  it('renders a placeholder when no drive is given', () => {
    render(<DriveChip />)
    expect(screen.getByText('Unknown drive')).toBeInTheDocument()
  })

  it('renders manufacturer, model, capacity and serial', () => {
    render(<DriveChip drive={makeDrive({ manufacturer_short: 'Seagate', model: 'Exos X16', capacity_bytes: 14e12, serial: 'ZTM0FF02' })} />)
    expect(screen.getByText('Seagate')).toBeInTheDocument()
    expect(screen.getByText('Exos X16')).toBeInTheDocument()
    expect(screen.getByText('14 TB')).toBeInTheDocument()
    expect(screen.getByText('ZTM0FF02')).toHaveClass('drive-chip-serial-full')
    expect(screen.getByText('FF02')).toHaveClass('drive-chip-serial-tail')
  })

  it('prefers the white label over the manufacturer, as the drive card does', () => {
    render(<DriveChip drive={makeDrive({ white_label: 'NETAPP', manufacturer_short: 'Seagate' })} />)
    expect(screen.getByText('NETAPP')).toBeInTheDocument()
    expect(screen.queryByText('Seagate')).not.toBeInTheDocument()
  })

  it('skips the manufacturer when the name already starts with it', () => {
    render(<DriveChip drive={makeDrive({ manufacturer_short: 'WDC', model: 'WDC WD40EFRX' })} />)
    expect(screen.queryByText('WDC')).not.toBeInTheDocument()
    expect(screen.getByText('WDC WD40EFRX')).toBeInTheDocument()
  })

  it('shows a user label in place of the model, keeping the model in the title', () => {
    render(<DriveChip drive={makeDrive({ label: 'booop', model: 'X316', serial: 'ZAD1V2H0' })} />)
    expect(screen.getByText('booop')).toBeInTheDocument()
    expect(screen.queryByText('X316')).not.toBeInTheDocument()
    expect(screen.getByText('booop').closest('.drive-chip')).toHaveAttribute('title', expect.stringContaining('booop (X316)'))
  })

  it('falls back to the device path when model is null', () => {
    render(<DriveChip drive={makeDrive({ model: null, device: '/dev/sdz' })} />)
    expect(screen.getByText('/dev/sdz')).toBeInTheDocument()
  })

  it('omits capacity when null', () => {
    render(<DriveChip drive={makeDrive({ capacity_bytes: null })} />)
    expect(screen.queryByText(/TB|GB|MB/)).not.toBeInTheDocument()
  })

  it('shows only the serial tail when asked, keeping the full serial in the title', () => {
    render(<DriveChip drive={makeDrive({ serial: 'ZTM0FF02' })} serial="tail" />)
    expect(screen.queryByText('ZTM0FF02')).not.toBeInTheDocument()
    expect(screen.getByText('FF02').closest('.drive-chip-serial')).toHaveClass('tail-only')
    expect(screen.getByText('FF02').closest('.drive-chip')).toHaveAttribute('title', expect.stringContaining('ZTM0FF02'))
  })

  it('colors the health dot by status and names it', () => {
    render(<DriveChip drive={makeDrive({ health_status: 'Failing', health_pct: 40 })} />)
    expect(screen.getByRole('img', { name: 'Failing 40' })).toHaveClass('crit')
  })

  it('marks a locked drive', () => {
    render(<DriveChip drive={makeDrive({ locked: true })} />)
    expect(screen.getByLabelText('locked')).toBeInTheDocument()
  })

  it('leads with a given mark in place of the health dot, keeping health in the title', () => {
    const { container } = render(<DriveChip drive={makeDrive({ health_status: 'Healthy', health_pct: 100 })} lead={<span data-testid="key" />} />)
    expect(screen.getByTestId('key')).toBeInTheDocument()
    expect(container.querySelector('.drive-chip-health')).toBeNull()
    expect(container.querySelector('.drive-chip')).toHaveAttribute('title', expect.stringContaining('Healthy 100'))
  })

  it('header puts the chip in a size container', () => {
    const { container } = render(<DriveChipHeader drive={makeDrive()} className="extra" />)
    expect(container.firstChild).toHaveClass('drive-chip-list', 'extra')
  })
})
