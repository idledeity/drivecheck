import { describe, expect, it } from 'vitest'
import { DRIVE_COPY_FIELDS, driveCopyText } from './driveCopyText'
import { makeDrive } from './test/fixtures'

const field = (key: string) => DRIVE_COPY_FIELDS.find(f => f.key === key)!

const netapp = makeDrive({
  guid: 'a', manufacturer_short: 'NETAPP', white_label: null, model: 'X316_SMBPE06TA07',
  capacity_bytes: 6_000_000_000_000, serial: 'ZAD1V2H0', device: '/dev/sdb',
  health_status: 'Failing', health_pct: 34, label: null,
})

describe('driveCopyText', () => {
  it('names a drive by its label when it has one, else manufacturer and model', () => {
    expect(driveCopyText(field('name'), [netapp])).toBe('NETAPP X316_SMBPE06TA07')
    expect(driveCopyText(field('name'), [{ ...netapp, label: 'Bay 3' }])).toBe('Bay 3')
  })

  it('prefers the white label over the manufacturer, as the card does', () => {
    expect(driveCopyText(field('name'), [{ ...netapp, white_label: 'HP' }])).toBe('HP X316_SMBPE06TA07')
  })

  it('copies serial and device path as they are', () => {
    expect(driveCopyText(field('serial'), [netapp])).toBe('ZAD1V2H0')
    expect(driveCopyText(field('device'), [netapp])).toBe('/dev/sdb')
  })

  it('sums a drive up on one line', () => {
    expect(driveCopyText(field('summary'), [{ ...netapp, label: 'Bay 3' }]))
      .toBe('NETAPP X316_SMBPE06TA07 6 TB "Bay 3" · S/N ZAD1V2H0 · /dev/sdb · Failing (34/100)')
  })

  it('says Unrated and a dash where the summary has nothing', () => {
    expect(driveCopyText(field('summary'), [{ ...netapp, serial: null, health_status: null, health_pct: null }]))
      .toBe('NETAPP X316_SMBPE06TA07 6 TB · S/N — · /dev/sdb · Unrated')
  })

  it('gives one line per drive, skipping drives without the field', () => {
    const second = { ...netapp, guid: 'b', serial: 'ZAD1ZSSQ', device: '/dev/sdc' }
    const noSerial = { ...netapp, guid: 'c', serial: null }
    expect(driveCopyText(field('serial'), [netapp, noSerial, second])).toBe('ZAD1V2H0\nZAD1ZSSQ')
  })

  it('is null when no drive has the field', () => {
    expect(driveCopyText(field('serial'), [{ ...netapp, serial: null }])).toBeNull()
  })
})
