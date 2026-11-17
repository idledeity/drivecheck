import { describe, expect, it } from 'vitest'
import { DEFAULT_FOOTER_SIGNALS, SIGNALS, formatSignal, healthSeverity, severityClass, signalName } from './signals'

describe('SIGNALS', () => {
  it('formats power_on_hours with locale-grouped thousands and a unit suffix', () => {
    expect(SIGNALS.power_on_hours.format(12345)).toBe('12,345h')
  })

  it('formats power_on_hours null as an em dash', () => {
    expect(formatSignal('power_on_hours', null)).toBe('—')
  })

  it('formats data written and read as sizes, link errors as a count', () => {
    expect(SIGNALS.data_written.format(224_927_797_112_832)).toBe('225 TB')
    expect(SIGNALS.data_read.format(2_526_525_336_000_000)).toBe('2.5 PB')
    expect(SIGNALS.link_errors.format(57)).toBe('57')
  })

  it('formats reallocated as a plain count', () => {
    expect(SIGNALS.reallocated.format(3)).toBe('3')
  })

  it('formats reallocated null as an em dash', () => {
    expect(formatSignal('reallocated', undefined)).toBe('—')
  })

  it('formats temp with a degree suffix', () => {
    expect(SIGNALS.temp.format(42)).toBe('42°C')
  })

  it('formats temp null as an em dash', () => {
    expect(formatSignal('temp', null)).toBe('—')
  })

  it('formats load_unload_cycles with locale-grouped thousands', () => {
    expect(SIGNALS.load_unload_cycles.format(12345)).toBe('12,345')
  })

  it('formats counters with locale-grouped thousands', () => {
    expect(formatSignal('reallocated', 1028)).toBe('1,028')
  })

  it('formats the SMART verdict as Passed/Failed', () => {
    expect(formatSignal('smart_passed', true)).toBe('Passed')
    expect(formatSignal('smart_passed', false)).toBe('Failed')
  })

  it('names and formats a signal it does not know rather than dropping it', () => {
    expect(signalName('media_errors')).toBe('Media errors')
    expect(formatSignal('media_errors', 7)).toBe('7')
  })
})

describe('severity', () => {
  it('maps flags to severity classes, ok to none', () => {
    expect(severityClass('warn')).toBe('sig-warn')
    expect(severityClass('crit')).toBe('sig-crit')
    expect(severityClass('ok')).toBe('')
    expect(severityClass(undefined)).toBe('')
  })

  it('maps health status to a severity', () => {
    expect(healthSeverity('Failing')).toBe('crit')
    expect(healthSeverity('Degraded')).toBe('warn')
    expect(healthSeverity('Healthy')).toBe('ok')
    expect(healthSeverity(null)).toBe('ok')
  })
})

describe('DEFAULT_FOOTER_SIGNALS', () => {
  it('uses pending/uncorrected for the default (ATA) drive type', () => {
    expect(DEFAULT_FOOTER_SIGNALS.default).toEqual(
      ['power_on_hours', 'reallocated', 'pending', 'uncorrected', 'crc_errors'],
    )
  })

  it('shows pending for SAS drives (background-scan errors not yet reassigned), no CRC errors', () => {
    expect(DEFAULT_FOOTER_SIGNALS.SAS).toEqual(['power_on_hours', 'reallocated', 'pending', 'uncorrected'])
  })

  it('every listed signal key has a corresponding SIGNALS descriptor', () => {
    for (const keys of Object.values(DEFAULT_FOOTER_SIGNALS)) {
      for (const key of keys) {
        expect(SIGNALS).toHaveProperty(key)
      }
    }
  })
})
