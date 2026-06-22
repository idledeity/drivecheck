import { describe, expect, it } from 'vitest'
import { formatCapacity, formatPercent, formatThroughput } from './format'

describe('formatCapacity', () => {
  it('returns an em dash for null', () => {
    expect(formatCapacity(null)).toBe('—')
  })

  it('formats terabytes', () => {
    expect(formatCapacity(1e12)).toBe('1 TB')
  })

  it('formats gigabytes', () => {
    expect(formatCapacity(500e9)).toBe('500 GB')
  })
})

describe('formatThroughput', () => {
  it('formats megabytes per second', () => {
    expect(formatThroughput(2.5e6)).toBe('2.5 MB/s')
  })
})

describe('formatPercent', () => {
  it('rounds to the nearest whole percent', () => {
    expect(formatPercent(42.6)).toBe('43%')
  })
})
