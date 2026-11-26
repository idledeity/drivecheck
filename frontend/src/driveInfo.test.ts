import { describe, expect, it } from 'vitest'
import { driveInfoText, formatInfoValue, unionLayout } from './driveInfo'
import type { DriveInfo } from './driveInfo'

const row = (key: string, value: string | number = key, format: 'text' | 'bytes' | 'size' | 'count' = 'text') =>
  ({ key, label: key.toUpperCase(), value, format })

describe('unionLayout', () => {
  it('puts a key only a later drive has after the row it follows there', () => {
    const sas: DriveInfo = { groups: [{ id: 'identity', title: 'Identity', as_of: null, rows: [row('manufacturer'), row('vendor_id'), row('model_number'), row('serial')] }] }
    const ata: DriveInfo = { groups: [{ id: 'identity', title: 'Identity', as_of: null, rows: [row('manufacturer'), row('model_number'), row('model_family'), row('serial')] }] }
    expect(unionLayout([sas, ata])[0].rows.map(r => r.key))
      .toEqual(['manufacturer', 'vendor_id', 'model_number', 'model_family', 'serial'])
  })

  it('keeps group order and adds groups only some drives have', () => {
    const a: DriveInfo = { groups: [{ id: 'identity', title: 'Identity', as_of: null, rows: [row('serial')] }] }
    const b: DriveInfo = { groups: [
      { id: 'identity', title: 'Identity', as_of: null, rows: [row('serial')] },
      { id: 'connection', title: 'Connection', as_of: null, rows: [row('pci_address')] },
    ] }
    expect(unionLayout([a, b]).map(g => g.id)).toEqual(['identity', 'connection'])
  })
})

describe('formatInfoValue', () => {
  it('formats by kind', () => {
    expect(formatInfoValue({ value: 6001175126016, format: 'bytes' })).toBe('6.0 TB (6,001,175,126,016 bytes)')
    expect(formatInfoValue({ value: 4096, format: 'size' })).toBe('4,096 bytes')
    expect(formatInfoValue({ value: 11721045168, format: 'count' })).toBe('11,721,045,168')
    expect(formatInfoValue({ value: 'SAS (SPL-4)', format: 'text' })).toBe('SAS (SPL-4)')
  })
})

describe('driveInfoText', () => {
  it('lists each group with aligned labels', () => {
    const info: DriveInfo = { groups: [{ id: 'media', title: 'Media', as_of: null, rows: [
      { key: 'capacity', label: 'Capacity', value: 3000592982016, format: 'bytes' },
      { key: 'logical_sector', label: 'Logical sector size', value: 512, format: 'size' },
    ] }] }
    expect(driveInfoText(info)).toEqual([
      'Media:',
      '  Capacity:            3.0 TB (3,000,592,982,016 bytes)',
      '  Logical sector size: 512 bytes',
      '',
    ])
  })
})
