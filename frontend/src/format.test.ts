import { describe, expect, it } from 'vitest'
import {
  formatCapacity,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatThroughput,
  formatTimestamp,
  humanizeKey,
  dayLabel,
  toLocalIso,
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

describe('dayLabel', () => {
  const now = new Date(2026, 10, 11, 0, 30).getTime()   // just after midnight

  it('names today and yesterday by calendar day, not 24-hour windows', () => {
    expect(dayLabel(new Date(2026, 10, 11, 0, 5).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 10, 23, 59).getTime(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 10, 10, 0, 1).getTime(), now)).toBe('Yesterday')
  })

  it('uses a short date for older days, adding the year only when it differs', () => {
    const older = dayLabel(new Date(2026, 10, 8, 12).getTime(), now)
    expect(older).toMatch(/8/)
    expect(older).not.toMatch(/2026/)
    expect(dayLabel(new Date(2025, 6, 1, 12).getTime(), now)).toMatch(/2025/)
  })

  it('handles the day after a DST change', () => {
    // Nov 2 follows the Nov 1 change in US zones; still exactly one day back.
    expect(dayLabel(new Date(2026, 10, 1, 12).getTime(), new Date(2026, 10, 2, 0, 30).getTime())).toBe('Yesterday')
  })
})

describe('toLocalIso', () => {
  it('formats local time without an offset', () => {
    expect(toLocalIso(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02T03:04:05')
  })
})
