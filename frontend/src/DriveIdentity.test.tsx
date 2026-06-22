import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DriveIdentity from './DriveIdentity'
import { makeDrive } from './test/fixtures'

describe('DriveIdentity', () => {
  it('renders a placeholder when no drive is given', () => {
    render(<DriveIdentity />)
    expect(screen.getByText('Unknown drive')).toBeInTheDocument()
  })

  it('renders manufacturer and model when present', () => {
    render(<DriveIdentity drive={makeDrive({ manufacturer: 'Acme', model: 'ModelX' })} />)
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('ModelX')).toBeInTheDocument()
  })

  it('falls back to the device path when model is null', () => {
    render(<DriveIdentity drive={makeDrive({ model: null, device: '/dev/sdz' })} />)
    expect(screen.getByText('/dev/sdz')).toBeInTheDocument()
  })

  it('renders capacity when present', () => {
    render(<DriveIdentity drive={makeDrive({ capacity_bytes: 1e12 })} />)
    expect(screen.getByText('1 TB')).toBeInTheDocument()
  })

  it('omits capacity when null', () => {
    render(<DriveIdentity drive={makeDrive({ capacity_bytes: null })} />)
    expect(screen.queryByText(/TB|GB|MB/)).not.toBeInTheDocument()
  })

  it('renders a user-assigned label in parentheses', () => {
    render(<DriveIdentity drive={makeDrive({ label: 'NAS pool #3' })} />)
    expect(screen.getByText('(NAS pool #3)')).toBeInTheDocument()
  })

  it('renders the serial by default when present', () => {
    render(<DriveIdentity drive={makeDrive({ serial: 'SN999' })} />)
    expect(screen.getByText('SN999')).toBeInTheDocument()
  })

  it('hides the serial when showSerial is false', () => {
    render(<DriveIdentity drive={makeDrive({ serial: 'SN999' })} showSerial={false} />)
    expect(screen.queryByText('SN999')).not.toBeInTheDocument()
  })

  it('renders no serial tag when the drive has none', () => {
    render(<DriveIdentity drive={makeDrive({ serial: null })} />)
    expect(screen.queryByText(/SN/)).not.toBeInTheDocument()
  })
})
