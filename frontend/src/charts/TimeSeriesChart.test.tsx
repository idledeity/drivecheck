import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TimeSeriesChart from './TimeSeriesChart'
import type { ChartSeries } from './TimeSeriesChart'
import ChartHoverSync from './ChartHoverSync'
import JobsDuring from './JobsDuring'
import type { ChartDrive } from './historySeries'

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

  it('reads every series at the focused time, in series order (not by value), and steps with the arrow keys', () => {
    render(chart())
    fireEvent.focus(svgs()[0])        // starts on the last bucket
    let rows = within(tip()!).getAllByText(/°C/).map(e => e.textContent)
    expect(rows).toEqual(['39 °C', '40 °C'])          // a, then b, though b reads higher

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

  it('shows every chart\'s readings under it, at the newest time, when the group asks for that', () => {
    const { container } = render(<ChartHoverSync readingsBelow>{chart()}{chart({ ariaLabel: 'Second' })}</ChartHoverSync>)
    expect(container.querySelectorAll('.tsc-tip.below')).toHaveLength(2)
    expect(container.querySelectorAll('.tsc-tip:not(.below)')).toHaveLength(0)
    fireEvent.pointerMove(svgs()[0], { clientX: 300, pointerType: 'mouse' })
    const times = [...container.querySelectorAll('.tsc-tip-time')].map(e => e.textContent)
    expect(times[0]).toBe(times[1])                       // both at the hovered time
    expect(container.querySelectorAll('.tsc-tip.below')).toHaveLength(2)
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

  it('sizes the left margin to its tick labels, the widest of a synced group', () => {
    const plotLeft = (svg: Element) => Number(svg.querySelector('.tsc-baseline')!.getAttribute('x1'))
    render(<>{chart()}{chart({ ariaLabel: 'Wide', formatY: v => `${v * 1000}` })}</>)
    const [narrow, wide] = svgs()
    expect(plotLeft(narrow)).toBeLessThan(plotLeft(wide))

    render(<ChartHoverSync>{chart({ ariaLabel: 'S1' })}{chart({ ariaLabel: 'S2', formatY: v => `${v * 1000}` })}</ChartHoverSync>)
    expect(plotLeft(screen.getByRole('img', { name: 'S1' }))).toBe(plotLeft(wide))
    expect(plotLeft(screen.getByRole('img', { name: 'S2' }))).toBe(plotLeft(wide))
  })

  it('puts the label before the value on each tooltip row', () => {
    render(chart())
    fireEvent.focus(svgs()[0])
    const row = tip()!.querySelector('.tsc-tip-row')!
    expect([...row.children].map(c => c.className)).toEqual(['tsc-tip-label', 'tsc-tip-value'])
    expect(row).toHaveTextContent('Exos FF0239 °C')       // a's row comes first
    expect(tip()!.querySelectorAll('.tsc-tip-row')[1]).toHaveTextContent('booop40 °C')
  })

  it('places a reading on a touch tap, grabbable, and keeps it when the finger lifts', () => {
    const { container } = render(chart())
    fireEvent.pointerDown(svgs()[0], { clientX: 300, pointerType: 'touch' })
    expect(tip()).toBeNull()                                   // a touch down alone does nothing
    fireEvent.pointerUp(svgs()[0], { clientX: 302, pointerType: 'touch' })
    fireEvent.pointerLeave(svgs()[0], { pointerType: 'touch' })
    expect(tip()).toHaveTextContent('35 °C')
    expect(container.querySelectorAll('.chart-grip')).toHaveLength(1)
    fireEvent.pointerLeave(svgs()[0], { pointerType: 'mouse' })
    expect(tip()).toBeNull()
  })

  it('leaves the reading alone when a touch drags (a scroll) instead of tapping', () => {
    render(chart())
    fireEvent.pointerDown(svgs()[0], { clientX: 300, clientY: 50, pointerType: 'touch' })
    fireEvent.pointerMove(svgs()[0], { clientX: 300, clientY: 80, pointerType: 'touch' })
    fireEvent.pointerUp(svgs()[0], { clientX: 300, clientY: 80, pointerType: 'touch' })
    expect(tip()).toBeNull()
    fireEvent.pointerDown(svgs()[0], { clientX: 300, pointerType: 'touch' })
    fireEvent.pointerCancel(svgs()[0], { pointerType: 'touch' })   // the browser took it as a scroll
    fireEvent.pointerUp(svgs()[0], { clientX: 300, pointerType: 'touch' })
    expect(tip()).toBeNull()
  })

  it('scrubs by dragging the line, and clears on a tap outside the charts', () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    let captured = false
    proto.setPointerCapture = () => { captured = true }
    proto.hasPointerCapture = () => captured
    try {
      const { container } = render(<><p>outside</p>{chart()}</>)
      fireEvent.pointerDown(svgs()[0], { clientX: 300, pointerType: 'touch' })
      fireEvent.pointerUp(svgs()[0], { clientX: 300, pointerType: 'touch' })
      const grip = container.querySelector('.chart-grip')!
      grip.getBoundingClientRect = () => ({ left: 278, width: 44 }) as DOMRect   // centred on the tap
      fireEvent.pointerDown(grip, { clientX: 300, pointerType: 'touch' })
      fireEvent.pointerMove(grip, { clientX: 100, pointerType: 'touch' })
      expect(tip()).not.toHaveTextContent('35 °C')
      expect(tip()).toHaveTextContent(/13:0[12]/)
      const outside = screen.getByText('outside')
      fireEvent.pointerDown(outside, { clientX: 5, pointerType: 'touch' })
      fireEvent.pointerUp(outside, { clientX: 5, pointerType: 'touch' })
      expect(tip()).toBeNull()
      expect(container.querySelector('.chart-grip')).toBeNull()
    } finally {
      delete proto.setPointerCapture
      delete proto.hasPointerCapture
    }
  })

  it('reads a step series as it stands at the end of the hovered bucket', () => {
    // Starts 20s into minute 2 and changes 30s into minute 5.
    const step: ChartSeries = { id: 's', label: 'Score', color: 'var(--s1)', shape: 'step',
      points: [{ t: START + 2 * MIN + 20e3, v: 35 }, { t: START + 5 * MIN + 30e3, v: 20 }] }
    render(chart({ series: [a, step] }))
    fireEvent.focus(svgs()[0])                                          // last bucket (a's)
    const at = (minute: number) => {
      for (let i = 9; i > minute; i--) fireEvent.keyDown(svgs()[0], { key: 'ArrowLeft' })
      const text = within(tip()!).queryByText('Score')?.closest('.tsc-tip-row')?.textContent ?? ''

      for (let i = 9; i > minute; i--) fireEvent.keyDown(svgs()[0], { key: 'ArrowRight' })
      return text
    }
    expect(at(2)).toContain('35 °C')        // not "No data": it starts inside the bucket
    expect(at(5)).toContain('20 °C')        // the change inside the bucket shows
    expect(at(1)).not.toContain('Score')
  })

  it('pins the time on a click: it stays as the pointer moves or leaves, and every synced chart shows its readings', () => {
    const { container } = render(<ChartHoverSync>{chart()}{chart({ ariaLabel: 'Second' })}</ChartHoverSync>)
    const times = () => [...container.querySelectorAll('.tsc-tip-time')].map(e => e.textContent)
    fireEvent.pointerMove(svgs()[0], { clientX: 300, pointerType: 'mouse' })
    expect(times()).toHaveLength(1)                       // hovering: the hovered chart only
    fireEvent.pointerDown(svgs()[0], { clientX: 300, pointerType: 'mouse', button: 0 })
    const pinnedAt = times()
    expect(pinnedAt).toHaveLength(2)                      // pinned: both charts
    expect(pinnedAt[0]).toBe(pinnedAt[1])
    fireEvent.pointerMove(svgs()[0], { clientX: 100, pointerType: 'mouse' })
    fireEvent.pointerMove(svgs()[1], { clientX: 500, pointerType: 'mouse' })
    fireEvent.pointerLeave(svgs()[0].closest('.tsc')!, { pointerType: 'mouse' })
    fireEvent.blur(svgs()[0])
    expect(times()).toEqual(pinnedAt)
  })

  it('unpins on another click, back to following the pointer, or on Escape', () => {
    const { container } = render(<ChartHoverSync>{chart()}{chart({ ariaLabel: 'Second' })}</ChartHoverSync>)
    const times = () => [...container.querySelectorAll('.tsc-tip-time')].map(e => e.textContent)
    fireEvent.pointerDown(svgs()[0], { clientX: 300, pointerType: 'mouse', button: 0 })
    const pinnedAt = times()[0]
    fireEvent.pointerDown(svgs()[1], { clientX: 300, pointerType: 'mouse', button: 0 })   // a click on any chart unpins
    expect(times()).toHaveLength(1)
    fireEvent.pointerMove(svgs()[1], { clientX: 100, pointerType: 'mouse' })
    expect(times()[0]).not.toBe(pinnedAt)                 // following the pointer again
    fireEvent.pointerDown(svgs()[1], { clientX: 100, pointerType: 'mouse', button: 0 })
    fireEvent.keyDown(svgs()[1], { key: 'ArrowRight' })   // the arrow keys move a pinned time, still pinned
    expect(times()).toHaveLength(2)
    fireEvent.keyDown(svgs()[1], { key: 'Escape' })
    expect(times()).toHaveLength(0)
  })

  it('ignores clicks other than the main button for pinning', () => {
    const { container } = render(<ChartHoverSync>{chart()}{chart({ ariaLabel: 'Second' })}</ChartHoverSync>)
    fireEvent.pointerDown(svgs()[0], { clientX: 300, pointerType: 'mouse', button: 2 })
    expect(container.querySelectorAll('.tsc-tip')).toHaveLength(0)
  })

  it('keeps the reading while the pointer moves from the plot onto the readings under it', () => {
    render(chart())
    fireEvent.pointerMove(svgs()[0], { clientX: 300, pointerType: 'mouse' })
    const wrap = svgs()[0].closest('.tsc')!
    fireEvent.pointerLeave(svgs()[0], { pointerType: 'mouse', relatedTarget: wrap })
    expect(tip()).not.toBeNull()
    fireEvent.pointerLeave(wrap, { pointerType: 'mouse' })
    expect(tip()).toBeNull()
  })

  it('scrubs along the time axis on a sideways drag, but leaves a vertical one to the page', () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    proto.setPointerCapture = () => {}
    try {
      const { container } = render(chart())
      const axis = container.querySelector('.chart-axis-scrub')!
      fireEvent.pointerDown(axis, { clientX: 300, clientY: 170, pointerType: 'touch' })
      fireEvent.pointerMove(axis, { clientX: 302, clientY: 190, pointerType: 'touch' })   // vertical first
      fireEvent.pointerMove(axis, { clientX: 400, clientY: 190, pointerType: 'touch' })
      fireEvent.pointerUp(axis, { clientX: 400, clientY: 190, pointerType: 'touch' })
      expect(tip()).toBeNull()
      fireEvent.pointerDown(axis, { clientX: 300, clientY: 170, pointerType: 'touch' })
      fireEvent.pointerMove(axis, { clientX: 320, clientY: 172, pointerType: 'touch' })   // sideways
      expect(tip()).toHaveTextContent('35 °C')
      fireEvent.pointerMove(axis, { clientX: 100, clientY: 172, pointerType: 'touch' })
      expect(tip()).not.toHaveTextContent('35 °C')
      fireEvent.pointerUp(axis, { clientX: 100, clientY: 172, pointerType: 'touch' })
      expect(tip()).not.toBeNull()                                    // stays, grabbable
      expect(container.querySelectorAll('.chart-grip')).toHaveLength(1)
    } finally {
      delete proto.setPointerCapture
    }
  })

  it('always shows the readings under narrow charts, every synced one at the same time', () => {
    // jsdom has no layout (clientWidth is 0): shadow it with a phone-ish width.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 })
    try {
      const { container } = render(<ChartHoverSync>{chart()}{chart({ ariaLabel: 'Second' })}</ChartHoverSync>)
      const tips = () => [...container.querySelectorAll('.tsc-tip')]
      // Nothing picked: both read the newest bucket, with no crosshair drawn.
      expect(tips()).toHaveLength(2)
      expect(tips()[0]).toHaveClass('below')
      tips().forEach(t => expect(t).toHaveTextContent('13:09'))
      expect(container.querySelector('.tsc-crosshair')).toBeNull()
      // A tap on one moves both, and the line can be grabbed in either.
      fireEvent.pointerDown(svgs()[1], { clientX: 180, pointerType: 'touch' })
      fireEvent.pointerUp(svgs()[1], { clientX: 180, pointerType: 'touch' })
      tips().forEach(t => expect(t).not.toHaveTextContent('13:09'))
      expect(tips()[0].textContent).toBe(tips()[1].textContent)
      expect(container.querySelectorAll('.chart-grip')).toHaveLength(2)
      // Dragging the line in the chart that wasn't tapped moves both.
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>
      let captured = false
      proto.setPointerCapture = () => { captured = true }
      proto.hasPointerCapture = () => captured
      try {
        const before = tips()[0].textContent
        const grip = svgs()[0].closest('.tsc')!.querySelector('.chart-grip')!
        grip.getBoundingClientRect = () => ({ left: 158, width: 44 }) as DOMRect
        fireEvent.pointerDown(grip, { clientX: 180, pointerType: 'touch' })
        fireEvent.pointerMove(grip, { clientX: 320, pointerType: 'touch' })
        expect(tips()[0].textContent).not.toBe(before)
        expect(tips()[0].textContent).toBe(tips()[1].textContent)
      } finally {
        delete proto.setPointerCapture
        delete proto.hasPointerCapture
      }
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
  })

  it('keeps the narrow readings one shape while scrubbing: every row, markers on rows, jobs on one line', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 })
    try {
      const drive = { guid: 'a', label: 'Exos FF02', style: { color: 'var(--s1)' } } as unknown as ChartDrive
      const jobsAt = (t: number) => t >= START + 8 * MIN
        ? [{ id: 'j1', name: 'badblocks', drive }, { id: 'j2', name: 'SMART long', drive }]
        : t >= START + 6 * MIN ? [{ id: 'j1', name: 'badblocks', drive }] : []
      const { container } = render(chart({
        markers: [{ series: 'a', t: START + 5 * MIN, label: 'First reading: Temperature · Exos FF02' }],
        tooltipExtra: (t, { compact }) => <JobsDuring jobs={jobsAt(t)} compact={compact} />,
      }))
      const tipEl = () => container.querySelector('.tsc-tip')!
      const shape = () => [tipEl().querySelectorAll('.tsc-tip-row').length, tipEl().querySelectorAll('.tsc-tip-extra').length]
      fireEvent.focus(svgs()[0])                                            // minute 9: two jobs
      expect(shape()).toEqual([2, 1])
      expect(within(tipEl() as HTMLElement).getByRole('button', { name: /2 jobs/ })).toBeInTheDocument()
      for (let i = 0; i < 2; i++) fireEvent.keyDown(svgs()[0], { key: 'ArrowLeft' })   // minute 7: one job
      expect(shape()).toEqual([2, 1])
      expect(tipEl()).toHaveTextContent('badblocks')
      for (let i = 0; i < 2; i++) fireEvent.keyDown(svgs()[0], { key: 'ArrowLeft' })   // minute 5: b empty, a's marker
      expect(shape()).toEqual([2, 1])
      expect(tipEl()).toHaveTextContent('No jobs')
      const row = (name: string) => within(tipEl() as HTMLElement).getByText(name).closest('.tsc-tip-row')!
      expect(row('booop')).toHaveTextContent('booop—')
      expect(row('Exos FF02')).toHaveTextContent('◇ first35 °C')
      expect(tipEl()).not.toHaveTextContent('First reading: Temperature')
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
  })

  it('lists several jobs in a popover from the narrow readings\' summary', () => {
    const drive = { guid: 'a', label: 'Exos FF02', style: { color: 'var(--s1)' } } as unknown as ChartDrive
    render(<JobsDuring compact jobs={[{ id: 'j1', name: 'badblocks', drive }, { id: 'j2', name: 'SMART long', drive }]} />)
    expect(screen.queryByText('badblocks')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /2 jobs/ }))      // jsdom has no hover: a tap pins it
    expect(screen.getByText('badblocks')).toBeInTheDocument()
    expect(screen.getByText('SMART long')).toBeInTheDocument()
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
