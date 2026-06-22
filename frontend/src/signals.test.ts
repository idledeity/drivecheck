import { describe, expect, it } from 'vitest'
import { DEFAULT_FOOTER_SIGNALS, SIGNALS } from './signals'

describe('SIGNALS', () => {
  it('formats power_on_hours with locale-grouped thousands and a unit suffix', () => {
    expect(SIGNALS.power_on_hours.format(12345)).toBe('12,345h')
  })

  it('formats power_on_hours null as an em dash', () => {
    expect(SIGNALS.power_on_hours.format(null)).toBe('—')
  })

  it('formats reallocated as a plain count', () => {
    expect(SIGNALS.reallocated.format(3)).toBe('3')
  })

  it('formats reallocated null as an em dash', () => {
    expect(SIGNALS.reallocated.format(null)).toBe('—')
  })

  it('formats temp with a degree suffix', () => {
    expect(SIGNALS.temp.format(42)).toBe('42°C')
  })

  it('formats temp null as an em dash', () => {
    expect(SIGNALS.temp.format(null)).toBe('—')
  })

  it('formats load_unload_cycles with locale-grouped thousands', () => {
    expect(SIGNALS.load_unload_cycles.format(12345)).toBe('12,345')
  })
})

describe('DEFAULT_FOOTER_SIGNALS', () => {
  it('uses pending/uncorrected for the default (ATA) drive type', () => {
    expect(DEFAULT_FOOTER_SIGNALS.default).toEqual(
      ['power_on_hours', 'reallocated', 'pending', 'uncorrected'],
    )
  })

  it('uses load_unload_cycles instead of pending for SAS drives', () => {
    expect(DEFAULT_FOOTER_SIGNALS.SAS).toEqual(
      ['power_on_hours', 'reallocated', 'load_unload_cycles', 'uncorrected'],
    )
  })

  it('every listed signal key has a corresponding SIGNALS descriptor', () => {
    for (const keys of Object.values(DEFAULT_FOOTER_SIGNALS)) {
      for (const key of keys) {
        expect(SIGNALS).toHaveProperty(key)
      }
    }
  })
})
