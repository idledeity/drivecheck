import type { ReactNode } from "react"
import {
  ChartGutterContext, ChartHoverContext, ChartLatestContext, ChartReadingsBelowContext,
  useChartGutterState, useChartHoverState, useChartLatestState,
} from "./chartHover"

/** Wrap charts that share a time axis to move their crosshairs together
 *  (and give them one left margin, so their plots line up, and one newest
 *  time for narrow charts' always-on readings). With readingsBelow, every
 *  chart shows its readings under it, as narrow ones do, whatever its width. */
export default function ChartHoverSync({ children, readingsBelow = false }: { children: ReactNode; readingsBelow?: boolean }) {
  const state = useChartHoverState()
  const gutter = useChartGutterState()
  const latest = useChartLatestState()
  return (
    <ChartGutterContext.Provider value={gutter}>
      <ChartLatestContext.Provider value={latest}>
        <ChartReadingsBelowContext.Provider value={readingsBelow}>
          <ChartHoverContext.Provider value={state}>{children}</ChartHoverContext.Provider>
        </ChartReadingsBelowContext.Provider>
      </ChartLatestContext.Provider>
    </ChartGutterContext.Provider>
  )
}
