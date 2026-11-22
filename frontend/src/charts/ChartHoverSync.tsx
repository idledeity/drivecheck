import type { ReactNode } from "react"
import {
  ChartGutterContext, ChartHoverContext, ChartLatestContext, useChartGutterState, useChartHoverState, useChartLatestState,
} from "./chartHover"

/** Wrap charts that share a time axis to move their crosshairs together
 *  (and give them one left margin, so their plots line up, and one newest
 *  time for narrow charts' always-on readings). */
export default function ChartHoverSync({ children }: { children: ReactNode }) {
  const state = useChartHoverState()
  const gutter = useChartGutterState()
  const latest = useChartLatestState()
  return (
    <ChartGutterContext.Provider value={gutter}>
      <ChartLatestContext.Provider value={latest}>
        <ChartHoverContext.Provider value={state}>{children}</ChartHoverContext.Provider>
      </ChartLatestContext.Provider>
    </ChartGutterContext.Provider>
  )
}
