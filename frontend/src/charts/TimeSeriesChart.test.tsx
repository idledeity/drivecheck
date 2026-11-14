import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TimeSeriesChart from './TimeSeriesChart'
import type { ChartSeries } from './TimeSeriesChart'
import ChartHoverSync from './ChartHoverSync'

const MIN = 60e3
const START = new Date(2026, 10, 12, 13, 0).getTime()
const END = START + 10 * MIN

// One point per minute bucket; b skips minute 5.
const a: ChartSeries = { id: 'a', label: 'Exos FF02', color: 'var(--s1)', points: [...Array(10)].map((_, i) => ({ t: START + i * MIN, v: 30 + i })) }
const b: ChartSeries = { id: 'b', label: 'booop', color: 'var(--s2)', points: [...Array(10)].map((_, i) => ({ t: START + i * MIN, v: i === 5 ? null : 40 })) }

const chart = (props: Partial<React.ComponentProps<typeof TimeSeriesChart>> = {}) => (
  <TimeSeriesChart series={[a, b]} start={START} end={END} snapMs={MIN} ariaLabel="Temperature" formatValue={v => `${v} °C`} {...props} />
)
const svgs = () => screen.getAllByRole('img')
const tip = () => screen.queryByRole('status')

describe('TimeSeriesChart', () => {
  it('draws one line per series', () => {
    const { container } = render(chart())
    expect(container.querySelectorAll('.tsc-line')).toHaveLength(2)
    expect(svgs()[0]).toHaveAccessibleName('Temperature')
  })

  it('reads every series at the focused time, highest first, and steps with the arrow keys', () => {
    render(chart())
    fireEvent.focus(svgs()[0])        // starts on the last bucket
    let rows = within(tip()!).getAllByText(/°C/).map(e => e.textContent)
    expect(rows).toEqual(['40 °C', '39 °C'])

    for (let i = 0; i < 4; i++) fireEvent.keyDown(svgs()[0], { key: 'ArrowLeft' })   // minute 5: b has no reading
    rows = within(tip()!).getAllByText(/°C/).map(e => e.textContent)
    expect(rows).toEqual(['35 °C'])

    fireEvent.keyDown(svgs()[0], { key: 'Escape' })
    expect(tip()).toBeNull()
  })

  it('stops the crosshair at the newest line point, but lets step series run to the end', () => {
    const svgRect = { left: 0, width: 600, top: 0, height: 180, right: 600, bottom: 180, x: 0, y: 0, toJSON() {} }
    const step: ChartSeries = { id: 'h', label: 'Health', color: 'var(--s1)', shape: 'step', points: [{ t: START, v: 100 }] }
    const { rerender } = render(chart({ series: [a], end: END + 5 * MIN }))
    svgs()[0].getBoundingClientRect = () => svgRect as DOMRect
    fireEvent.pointerMove(svgs()[0], { clientX: 599 })
    expect(tip()).toHaveTextContent('39 °C')            // minute 9, a's newest point
    rerender(chart({ series: [step], end: END + 5 * MIN }))
    fireEvent.pointerMove(svgs()[0], { clientX: 599 })
    expect(tip()).toHaveTextContent(/13:15/)
    expect(tip()).toHaveTextContent('100 °C')
  })

  it('moves the crosshair in every synced chart but shows the tooltip only in the hovered one', () => {
    const { container } = render(<ChartHoverSync>{chart()}{chart({ ariaLabel: 'Second' })}</ChartHoverSync>)
    fireEvent.focus(svgs()[0])
    expect(container.querySelectorAll('.tsc-crosshair')).toHaveLength(2)
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('keeps hover to itself outside a ChartHoverSync', () => {
    const { container } = render(<>{chart()}{chart({ ariaLabel: 'Second' })}</>)
    fireEvent.focus(svgs()[0])
    expect(container.querySelectorAll('.tsc-crosshair')).toHaveLength(1)
  })

  it('lists extra lines for the hovered time, such as a job running then', () => {
    render(chart({ tooltipExtra: t => (t >= START + 8 * MIN ? 'badblocks · Exos FF02' : null) }))
    fireEvent.focus(svgs()[0])
    expect(tip()).toHaveTextContent('badblocks · Exos FF02')
    fireEvent.keyDown(svgs()[0], { key: 'ArrowLeft' })
    fireEvent.keyDown(svgs()[0], { key: 'ArrowLeft' })
    expect(tip()).not.toHaveTextContent('badblocks')
  })

  it('draws thresholds inside the domain, which yInclude can widen to reach', () => {
    const { container, rerender } = render(chart({ thresholds: [{ value: 45, label: '45 °C warning', tone: 'warn' }] }))
    expect(container.querySelector('.tsc-threshold')).toBeNull()
    rerender(chart({ thresholds: [{ value: 45, label: '45 °C warning', tone: 'warn' }], yInclude: [47] }))
    expect(screen.getByText('45 °C warning')).toBeInTheDocument()
  })

  it('labels line ends only when they would not collide', () => {
    const { rerender } = render(chart({ endLabels: true }))
    expect(screen.getByText('Exos FF02', { selector: '.tsc-end-label' })).toBeInTheDocument()
    const close: ChartSeries = { ...b, points: a.points.map(p => ({ t: p.t, v: (p.v ?? 0) + 0.01 })) }
    rerender(chart({ series: [a, close], endLabels: true }))
    expect(document.querySelector('.tsc-end-label')).toBeNull()
  })

  it('merges overlapping spans into one shade', () => {
    const { container } = render(chart({ spans: [
      { id: 'a', start: START + MIN, end: START + 4 * MIN },
      { id: 'b', start: START + 3 * MIN, end: START + 5 * MIN },
      { id: 'c', start: START + 8 * MIN, end: START + 9 * MIN },
    ] }))
    expect(container.querySelectorAll('.tsc-span')).toHaveLength(2)
  })

  it('shades spans clipped to the range, running ones to the end', () => {
    const { container } = render(chart({ spans: [
      { id: 'j1', start: START - 60 * MIN, end: START + 2 * MIN },
      { id: 'j2', start: START + 6 * MIN, end: null },
      { id: 'j3', start: START - 60 * MIN, end: START - 30 * MIN },
    ] }))
    expect(container.querySelectorAll(".tsc-span")).toHaveLength(2)
  })
})
