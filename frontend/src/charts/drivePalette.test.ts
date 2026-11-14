import { describe, expect, it } from 'vitest'
import { driveColorOrder, driveStyles, seriesStyle } from './drivePalette'

describe('drive colors', () => {
  it('orders drives by when they were first seen, never-seen last, guid breaking ties', () => {
    expect(driveColorOrder([
      { guid: 'c', first_seen: null },
      { guid: 'b', first_seen: '2026-11-02T00:00:00' },
      { guid: 'a', first_seen: '2026-11-02T00:00:00' },
      { guid: 'z', first_seen: '2026-10-01T00:00:00' },
    ])).toEqual(['z', 'a', 'b', 'c'])
  })

  it('gives each position a fixed solid hue, repeating past twelve', () => {
    expect(driveStyles(['x', 'y'])).toEqual({ x: { color: 'var(--s1)' }, y: { color: 'var(--s2)' } })
    expect(seriesStyle(11)).toEqual({ color: 'var(--s12)' })
    expect(seriesStyle(12)).toEqual({ color: 'var(--s1)' })
  })
})
