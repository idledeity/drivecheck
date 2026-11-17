import { describe, expect, it } from 'vitest'
import { COUNTER_SIGNALS, counterFormat, counterKind, counterScale } from './counters'

describe('counter formats', () => {
  it('reads byte counters as sizes, and their faster rates as workload, not warnings', () => {
    const f = counterFormat('data_written')
    expect(f.value(74_649_922_000_000)).toBe('74.6 TB')
    expect(f.value(-2_000_000_000)).toBe('−2.0 GB')
    expect(f.rate(1_500_000_000_000)).toBe('1.5 TB')
    expect(f.axis(300_000_000_000_000)).toBe('300 TB')
    expect(f.workload).toBe(true)
  })

  it('reads every other counter as a count', () => {
    const f = counterFormat('link_errors')
    expect(f.value(1234)).toBe((1234).toLocaleString())
    expect(f.rate(4.25)).toBe('4.3')
    expect(f.workload).toBe(false)
  })

  it('charts link errors as an error count and data written as a wear count', () => {
    expect(COUNTER_SIGNALS).toContain('link_errors')
    expect(COUNTER_SIGNALS).toContain('data_written')
    expect([counterKind('link_errors'), counterScale('link_errors')]).toEqual(['event', 'log1p'])
    expect([counterKind('data_written'), counterScale('data_written')]).toEqual(['wear', 'linear'])
  })
})
