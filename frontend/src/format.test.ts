import { describe, expect, it } from 'vitest'
import {
  formatCapacity,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatThroughput,
  formatTimestamp,
  humanizeKey,
} from './format'

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

  it('formats megabytes below the gigabyte threshold', () => {
    expect(formatCapacity(500e6)).toBe('500 MB')
  })
})

describe('formatThroughput', () => {
  it('returns an em dash for null', () => {
    expect(formatThroughput(null)).toBe('—')
  })

  it('formats megabytes per second', () => {
    expect(formatThroughput(2.5e6)).toBe('2.5 MB/s')
  })

  it('formats kilobytes per second', () => {
    expect(formatThroughput(2.5e3)).toBe('3 KB/s')
  })

  it('formats bytes per second below the kilobyte threshold', () => {
    expect(formatThroughput(500)).toBe('500 B/s')
  })
})

describe('formatPercent', () => {
  it('returns an em dash for null', () => {
    expect(formatPercent(null)).toBe('—')
  })

  it('rounds to the nearest whole percent', () => {
    expect(formatPercent(42.6)).toBe('43%')
  })
})

describe('formatRelativeTime', () => {
  const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()

  it('formats sub-minute timestamps as "just now"', () => {
    expect(formatRelativeTime(secondsAgo(30))).toBe('just now')
  })

  it('formats sub-hour timestamps in minutes', () => {
    expect(formatRelativeTime(secondsAgo(5 * 60))).toBe('5m ago')
  })

  it('formats sub-day timestamps in hours', () => {
    expect(formatRelativeTime(secondsAgo(5 * 3600))).toBe('5h ago')
  })

  it('formats multi-day timestamps in days', () => {
    expect(formatRelativeTime(secondsAgo(5 * 86400))).toBe('5d ago')
  })

  it('clamps future timestamps to "just now" instead of going negative', () => {
    expect(formatRelativeTime(secondsAgo(-30))).toBe('just now')
  })
})

describe('formatDuration', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(45)).toBe('45s')
  })

  it('formats sub-hour durations in minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s')
  })

  it('formats multi-hour durations in hours and minutes', () => {
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe('2h 5m')
  })

  it('clamps negative durations to zero', () => {
    expect(formatDuration(-5)).toBe('0s')
  })
})

describe('formatTimestamp', () => {
  it('renders a non-empty, locale-formatted string', () => {
    const result = formatTimestamp('2026-01-15T12:30:00Z')
    expect(result.length).toBeGreaterThan(0)
    expect(result).toMatch(/2026/)
  })
})

describe('humanizeKey', () => {
  it('replaces underscores with spaces and capitalizes the first letter', () => {
    expect(humanizeKey('test_type')).toBe('Test type')
  })

  it('leaves a single word capitalized', () => {
    expect(humanizeKey('duration')).toBe('Duration')
  })
})
