import { flushSync } from "react-dom"
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { FocusEvent, KeyboardEvent, PointerEvent, RefObject } from "react"
import { onReadings, useChartHover, useGroupLatest, useReadingsBelow } from "./chartHover"
import type { HoverFlags } from "./chartHover"
import { useTapOutside, useTouchTap } from "./chartTouch"

// How a chart on the shared time axis (TimeSeriesChart, CounterLanesChart)
// is read: the pointer, a click, touch, the keyboard and focus all set the
// hover (shared under a ChartHoverSync, see chartHover); this turns it back
// into what the chart draws — where the crosshair is, whether the readings
// show and at what time. The chart says only how a time snaps to its data.

// Below this chart width the tooltip would cover most of the plot (and run
// off a phone screen), so the readings show under the chart instead —
// always, at the newest reading until a time is picked, so every chart in a
// group reads at one time and the page doesn't jump as they come and go.
const TIP_BELOW_WIDTH = 520

export interface ChartPointerOptions {
  /** The chart's useId: the hover's source while the pointer is in it. */
  id: string
  start: number
  end: number
  /** The chart's measured width, px. */
  width: number
  /** The element whose box client x is read against (scaled to `width`:
   *  the rendered width can briefly differ from the measured one mid-resize). */
  hostRef: RefObject<Element | null>
  /** The chart's whole block: focus moving within it keeps the reading. */
  wrapRef: RefObject<Element | null>
  /** Time ↔ px in the chart's own width. */
  x: (t: number) => number
  toT: (px: number) => number
  /** A raw time (from the pointer) → the data position to show. */
  place: (t: number) => number | null
  /** The position one step from t, for the arrow keys; null stays put. */
  step: (t: number, dir: 1 | -1) => number | null
  /** Where the keyboard starts when nothing is hovered: the newest data. */
  latest: () => number | null
  /** This chart's newest time, which narrow charts read at until a time is
   *  picked (the group's earliest, see useGroupLatest). */
  newest: number | null
  /** The chart's floating tooltip, placed beside the crosshair. */
  tipRef: RefObject<HTMLDivElement | null>
  /** A time from the group (another chart's, or the newest) → this chart's
   *  position for it, e.g. the wide bar holding it. Default: as is. */
  readAt?: (t: number) => number
}

export function useChartPointer(o: ChartPointerOptions) {
  const { id, start, end, width } = o
  const { hover, setHover } = useChartHover()
  const hoverAt = (t: number | null, flags: HoverFlags = {}) => setHover(t === null ? null : { t, source: id, ...flags })
  const clientT = (clientX: number) => {
    const r = o.hostRef.current!.getBoundingClientRect()
    return o.toT(((clientX - r.left) / (r.width || width)) * width)
  }
  const placeX = (clientX: number) => o.place(clientT(clientX))

  // Mouse and pen hover, and a click pins the time (or unpins it, back to
  // following the pointer); touch only taps (see chartTouch). A tap or click
  // on the readings is just reading them.
  const pinned = !!hover?.pinned
  const tap = useTouchTap(e => {
    if (!onReadings(e.target)) hoverAt(placeX(e.clientX), { touch: true })
  })

  // Pointer moves set the hover once per frame, at the newest x, and render
  // in that frame (flushSync), before it paints: left to React's scheduler,
  // the render would run after the paint, a frame behind the pointer. Ref'd
  // so the frame reads this render's data, not the one that asked for it. A
  // click or leave drops a frame still waiting.
  const frame = useRef<number | null>(null)
  const pending = useRef(0)
  const follow = useRef<(clientX: number) => void>(() => {})
  useLayoutEffect(() => { follow.current = clientX => hoverAt(placeX(clientX)) })
  const cancelMove = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }
  useEffect(() => cancelMove, [])
  const moveTo = (clientX: number) => {
    pending.current = clientX
    if (frame.current !== null) return
    let ran = false
    const handle = requestAnimationFrame(() => {
      ran = true
      frame.current = null
      flushSync(() => follow.current(pending.current))
    })
    if (!ran) frame.current = handle
  }

  // A reading placed by touch: its line can be grabbed in every chart that
  // draws it, and a tap outside the charts clears it (watched by the chart
  // that placed it).
  const gripped = !!hover?.touch
  const clearHover = useCallback(() => setHover(null), [setHover])
  useTapOutside(gripped && hover.source === id, clearHover)

  const events = {
    onPointerMove: (e: PointerEvent<Element>) => {
      tap.move(e)
      if (e.pointerType !== "touch" && !pinned && !onReadings(e.target)) moveTo(e.clientX)
    },
    onPointerDown: (e: PointerEvent<Element>) => {
      tap.down(e)
      if (e.pointerType === "touch" || e.button !== 0 || onReadings(e.target)) return
      cancelMove()
      hoverAt(placeX(e.clientX), { pinned: !pinned })
    },
    onPointerUp: tap.up,
    onPointerCancel: tap.cancel,
    // Keyboard users get a reading straight away.
    onFocus: () => { if (!hover) hoverAt(o.latest()) },
    // Only the chart that set the reading clears it: tapping another chart
    // in the group blurs this one after that chart placed its own. Focus
    // moving within the chart (into its readings) keeps it, and a tapped
    // reading is cleared by a tap outside the charts instead (useTapOutside):
    // a tap on the readings blurs the plot too. A pinned time is unpinned
    // only by a click on a chart, or Escape.
    onBlur: (e: FocusEvent<Element>) => {
      if (hover?.source !== id || hover.touch || pinned) return
      if (!(e.relatedTarget instanceof Node && o.wrapRef.current?.contains(e.relatedTarget))) hoverAt(null)
    },
    onKeyDown: (e: KeyboardEvent<Element>) => {
      if (e.key === "Escape") return hoverAt(null)
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      e.preventDefault()
      const from = hover?.t ?? o.latest()
      const to = from === null ? null : o.step(from, e.key === "ArrowRight" ? 1 : -1)
      if (to !== null) hoverAt(to, { pinned })
    },
  }
  // Leaving the chart's whole block clears the reading, not just leaving the
  // plot: readings shown under a narrow chart must stay while the pointer
  // moves down to read them. A lifted finger "leaves" too, which would clear
  // a tap's reading as soon as it showed; on touch it stays until focus
  // moves (a tap elsewhere). A pinned time stays too.
  const onPointerLeave = (e: PointerEvent<Element>) => {
    if (e.pointerType === "touch" || pinned) return
    cancelMove()
    hoverAt(null)
  }
  /** Touch scrubbing (the line's grip, the time axis) to a client x. */
  const scrubTo = (clientX: number) => hoverAt(placeX(clientX), { touch: true })

  // A synced chart may be handed a time outside this chart's range; ignore it.
  const readAt = o.readAt ?? ((t: number) => t)
  const at = hover && hover.t >= start && hover.t <= end ? readAt(hover.t) : null
  const readingsBelow = useReadingsBelow()
  const tipBelow = width < TIP_BELOW_WIDTH || readingsBelow
  // The time the readings are for: the hovered one, or on a narrow chart
  // (readings always shown) the newest — the group's, so all charts agree.
  const newest = useGroupLatest(id, o.newest)
  const tipT = at ?? (tipBelow && newest !== null && newest >= start ? readAt(newest) : null)
  // Every chart in a sync group draws the crosshair; only the hovered one
  // draws the floating tooltip, unless the time is pinned. Narrow charts all
  // show their readings.
  const isSource = at !== null && hover?.source === id
  const showTip = tipT !== null && (tipBelow || isSource || (pinned && at !== null))
  const hx = at === null ? 0 : o.x(at)

  // A floating tooltip sits right of the crosshair, or left of it where it
  // would run past the chart's right edge, and is kept inside the chart
  // either way. Placed after layout, since that needs the tooltip's width;
  // still before paint, so it never shows in the wrong place.
  const { tipRef } = o
  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || tipBelow) return
    const w = tip.offsetWidth
    const left = hx + 12 + w <= width ? hx + 12 : hx - 12 - w
    tip.style.left = `${Math.max(0, Math.min(left, width - w))}px`
  })

  return { at, hx, tipT, showTip, isSource, tipBelow, pinned, gripped, events, onPointerLeave, scrubTo }
}
