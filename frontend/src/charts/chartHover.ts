import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react"

// Shared crosshair for charts on one time axis: hovering one chart moves the
// crosshair in every chart under the same ChartHoverSync, and only the chart
// under the pointer shows its tooltip. A chart outside any ChartHoverSync
// (e.g. alone in a drive-card popover) keeps its hover to itself.

export interface ChartHover {
  /** The hovered time (ms), already snapped to a data position. */
  t: number
  /** Which chart the pointer is in (its useId). */
  source: string
}

interface HoverState {
  hover: ChartHover | null
  setHover: (hover: ChartHover | null) => void
}

export const ChartHoverContext = createContext<HoverState | null>(null)

export function useChartHoverState(): HoverState {
  const [hover, setHoverState] = useState<ChartHover | null>(null)
  const setHover = useCallback((next: ChartHover | null) => {
    setHoverState(prev => (prev?.t === next?.t && prev?.source === next?.source ? prev : next))
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
