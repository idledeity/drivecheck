import { describe, expect, it } from 'vitest'
import { formatTick, log1pTicks, niceTicks, timeTicks, yScale } from './scales'

describe('niceTicks', () => {
  it('rounds out to clean steps covering the range', () => {
    expect(niceTicks(27.4, 46.2, 4)).toEqual([25, 30, 35, 40, 45, 50])
    expect(niceTicks(0, 262, 4)).toEqual([0, 100, 200, 300])
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100])
  })

  it('opens up a flat range instead of collapsing it', () => {
    const ticks = niceTicks(30, 30, 4)
    expect(ticks[0]).toBeLessThan(30)
    expect(ticks[ticks.length - 1]).toBeGreaterThan(30)
  })
})

describe('log1pTicks', () => {
  it('runs in decades to the first at or above the max, at least to 10', () => {
    expect(log1pTicks(0)).toEqual([0, 1, 10])
    expect(log1pTicks(1028)).toEqual([0, 1, 10, 100, 1000, 10000])
  })
})

describe('yScale', () => {
  it('maps linearly, bottom to top', () => {
    const y = yScale('linear', 0, 100, 200, 0)
    expect(y(0)).toBe(200)
    expect(y(50)).toBe(100)
    expect(y(100)).toBe(0)
  })

  it('log1p keeps zero on the baseline and spaces decades evenly', () => {
    const y = yScale('log1p', 0, 999, 300, 0)
    expect(y(0)).toBe(300)
    expect(y(9)).toBeCloseTo(200)
    expect(y(99)).toBeCloseTo(100)
  })
})

describe('formatTick', () => {
  it('writes values in full under 10,000 and compact from there', () => {
    expect(formatTick(2500)).toBe((2500).toLocaleString())
    expect(formatTick(20000)).toBe('20K')
    expect(formatTick(2_500_000)).toBe('2.5M')
  })
})

describe('timeTicks', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()

  it('picks the smallest round spacing that fits, on whole local times', () => {
    const ticks = timeTicks(at(12, 13, 7), at(12, 14, 7), 4)
    expect(ticks.map(t => t.label)).toEqual(['13:15', '13:30', '13:45', '14:00'])
  })

  it('labels midnight with the date', () => {
    const ticks = timeTicks(at(11, 18), at(12, 18), 6)
    expect(ticks.map(t => t.t)).toEqual([at(11, 18), at(12, 0), at(12, 6), at(12, 12), at(12, 18)])
    expect(ticks[1].label).not.toMatch(/:/)
  })

  it('places multi-day ticks on fixed days, so they hold still as the range moves', () => {
    const a = timeTicks(at(1, 9), at(30, 9), 4).map(t => t.t)
    const b = timeTicks(at(2, 9), at(30, 21), 4).map(t => t.t)
    expect(a.length).toBeGreaterThan(1)
    expect(b.filter(t => a.includes(t)).length).toBe(b.length)
    a.forEach(t => expect(new Date(t).getHours()).toBe(0))
  })
})
