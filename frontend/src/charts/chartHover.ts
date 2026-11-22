import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react"

// Shared crosshair for charts on one time axis: hovering one chart moves the
// crosshair in every chart under the same ChartHoverSync, and only the chart
// under the pointer shows its tooltip (every chart, while a time is pinned). A chart outside any ChartHoverSync
// (e.g. alone in a drive-card popover) keeps its hover to itself.

export interface ChartHover {
  /** The hovered time (ms), already snapped to a data position. */
  t: number
  /** Which chart the pointer is in (its useId). */
  source: string
  /** Placed by touch (a tap, the line's grip or an axis scrub): that
   *  chart's line can be grabbed, and a tap outside the charts clears it. */
  touch?: boolean
  /** Pinned by a mouse (or pen) click: it stays put while the pointer moves
   *  on or leaves the charts, and every chart in the group shows its
   *  readings, until a click on a chart (or Escape) unpins it. */
  pinned?: boolean
}

/** Optional flags for a new hover: how it was placed. */
export type HoverFlags = Pick<ChartHover, "touch" | "pinned">

/** A click on a chart's readings (a pinned tooltip, or readings under a
 *  narrow chart) is reading them, not pinning or unpinning the time. */
export const onReadings = (target: EventTarget) => target instanceof Element && !!target.closest(".tsc-tip")

interface HoverState {
  hover: ChartHover | null
  setHover: (hover: ChartHover | null) => void
}

export const ChartHoverContext = createContext<HoverState | null>(null)

export function useChartHoverState(): HoverState {
  const [hover, setHoverState] = useState<ChartHover | null>(null)
  const setHover = useCallback((next: ChartHover | null) => {
    setHoverState(prev => (prev?.t === next?.t && prev?.source === next?.source
      && !prev?.touch === !next?.touch && !prev?.pinned === !next?.pinned ? prev : next))
  }, [])
  // The same object until the hover changes: it's a context value, and a new
  // object would re-render every chart in the group whenever the parent does
  // (e.g. on each 2s poll) even though nothing about the hover moved.
  return useMemo(() => ({ hover, setHover }), [hover, setHover])
}

/** The shared hover if inside a ChartHoverSync, else a chart-local one. */
export function useChartHover(): HoverState {
  const shared = useContext(ChartHoverContext)
  const local = useChartHoverState()
  return shared ?? local
}

// ── readings below ───────────────────────────────────────────────────────────
// A group can ask for every chart's readings under it, in the page flow, at
// any width (as narrow charts always do): on a page of charts, a tooltip
// floating over one hides its lines, and only one chart's shows at a time.

export const ChartReadingsBelowContext = createContext(false)

/** Whether this chart's group wants readings under every chart. */
export const useReadingsBelow = () => useContext(ChartReadingsBelowContext)

// ── shared left gutter ───────────────────────────────────────────────────────
// Each chart sizes its left margin to its own y tick labels. Charts under one
// ChartHoverSync share a time axis, so they all take the widest margin any of
// them needs — otherwise their plots, and crosshairs, wouldn't line up.

interface GutterState {
  /** The widest left margin any chart in the group needs, px. */
  left: number
  /** A chart's needed margin, or null when it unmounts. */
  report: (id: string, px: number | null) => void
}

export const ChartGutterContext = createContext<GutterState | null>(null)

export function useChartGutterState(): GutterState {
  const [needs, setNeeds] = useState<Record<string, number>>({})
  const report = useCallback((id: string, px: number | null) => {
    setNeeds(prev => {
      if ((prev[id] ?? null) === px) return prev
      const next = { ...prev }
      if (px === null) delete next[id]
      else next[id] = px
      return next
    })
  }, [])
  const left = Math.max(0, ...Object.values(needs))
  return useMemo(() => ({ left, report }), [left, report])
}

/** The left margin for a chart that needs `need` px: its own, or in a
 *  ChartHoverSync group, the group's widest. */
export function useLeftGutter(id: string, need: number): number {
  const group = useContext(ChartGutterContext)
  // report is stable, so these run only when the need (or chart) changes.
  const report = group?.report
  useLayoutEffect(() => { report?.(id, need) }, [report, id, need])
  useLayoutEffect(() => () => report?.(id, null), [report, id])
  return group ? Math.max(group.left, need) : need
}

// ── shared newest time ───────────────────────────────────────────────────────
// Narrow charts always show readings, at the newest time until one is picked.
// Charts in a group can disagree on "newest" (a line stops at its newest
// complete bucket; a counter runs to the range end), so the group reads at
// the earliest of them: one time across every chart, with data in each.

interface LatestState {
  /** The earliest newest time any chart in the group reported, or null. */
  latest: number | null
  report: (id: string, t: number | null) => void
}

export const ChartLatestContext = createContext<LatestState | null>(null)

export function useChartLatestState(): LatestState {
  const [times, setTimes] = useState<Record<string, number>>({})
  const report = useCallback((id: string, t: number | null) => {
    setTimes(prev => {
      if ((prev[id] ?? null) === t) return prev
      const next = { ...prev }
      if (t === null) delete next[id]
      else next[id] = t
      return next
    })
  }, [])
  const values = Object.values(times)
  const latest = values.length ? Math.min(...values) : null
  return useMemo(() => ({ latest, report }), [latest, report])
}

/** The time a chart reads at when nothing is picked: its own newest `own`,
 *  or in a ChartHoverSync group, the group's earliest newest. */
export function useGroupLatest(id: string, own: number | null): number | null {
  const group = useContext(ChartLatestContext)
  const report = group?.report
  useLayoutEffect(() => { report?.(id, own) }, [report, id, own])
  useLayoutEffect(() => () => report?.(id, null), [report, id])
  return group?.latest ?? own
}

// ── picking a drive from the readings ────────────────────────────────────────
// A page of charts (Trends) can let a click on a readings row highlight that
// series across every chart; it holds which one is picked and passes the
// result back in as each chart's highlight. Without a provider (e.g. a lone
// chart in a drive-card popover) rows aren't clickable.

/** Pick (or, if it's already picked, unpick) a series by id. */
export const ChartPickContext = createContext<((id: string) => void) | null>(null)

export const useChartPick = () => useContext(ChartPickContext)

/** A readings row's extra class (" dim" while another series is
 *  highlighted, " pickable" where rows pick) and, where the page lets rows
 *  pick, the props that make it a toggle for its series. */
export function readingRow(pick: ((id: string) => void) | null, id: string, highlight: string | null) {
  const cls = (highlight !== null && highlight !== id ? " dim" : "") + (pick ? " pickable" : "")
  const props = pick ? {
    role: "button",
    tabIndex: 0,
    "aria-pressed": highlight === id,
    onClick: () => pick(id),
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(id) }
    },
  } : {}
  return { cls, props }
}
