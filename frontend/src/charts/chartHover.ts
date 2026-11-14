import { createContext, useCallback, useContext, useMemo, useState } from "react"

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
