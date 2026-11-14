import { describe, expect, it } from 'vitest'
import { seriesPaths, valueAt } from './chartGeometry'
import type { ChartSeries } from './chartGeometry'

// Identity scales, so path coordinates read as the data.
const x = (t: number) => t
const y = (v: number) => v
const series = (points: [number, number | null][], o: Partial<ChartSeries> = {}): ChartSeries =>
  ({ id: 's', label: 'S', color: 'red', points: points.map(([t, v]) => ({ t, v })), ...o })

describe('seriesPaths', () => {
  it('joins points, breaking at nulls and at gaps longer than gapMs', () => {
    const { line, last } = seriesPaths(series([[0, 1], [10, 2], [20, null], [30, 3], [40, 4], [100, 5]]), x, y, 100, 15, 0)
    expect(line).toBe('M0.0,1.0L10.0,2.0M30.0,3.0L40.0,4.0M100.0,5.0')
    expect(last).toEqual({ x: 100, y: 5 })
  })

  it('draws a step series flat until the next point, and its last value on to the end', () => {
    const { line, last } = seriesPaths(series([[0, 1], [50, 3]], { shape: 'step' }), x, y, 80, 15, 0)
    expect(line).toBe('M0.0,1.0H50.0V3.0H80.0')
    expect(last).toEqual({ x: 80, y: 3 })
  })

  it('closes an area down to the baseline per run', () => {
    const { area } = seriesPaths(series([[0, 1], [10, 2]], { area: true }), x, y, 10, 15, 0)
    expect(area).toBe('M0.0,0.0L0.0,1.0L10.0,2.0L10.0,0.0Z')
  })
})

describe('valueAt', () => {
  it('reads a step series as the latest value at or before t', () => {
    const s = series([[10, 1], [20, 2]], { shape: 'step' })
    expect(valueAt(s, 5)).toBeNull()
    expect(valueAt(s, 10)).toBe(1)
    expect(valueAt(s, 19)).toBe(1)
    expect(valueAt(s, 99)).toBe(2)
  })

  it('reads a line only where it has a point, within half a bucket', () => {
    const s = series([[0, 1], [60, 2]])
    expect(valueAt(s, 60, 60)).toBe(2)
    expect(valueAt(s, 120, 60)).toBeNull()   // a missing bucket isn't the neighbour's value
    expect(valueAt(s, 59)).toBeNull()
  })
})
