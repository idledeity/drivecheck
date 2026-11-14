import type { ReactNode } from "react"
import { ChartGutterContext, ChartHoverContext, useChartGutterState, useChartHoverState } from "./chartHover"

/** Wrap charts that share a time axis to move their crosshairs together
 *  (and give them one left margin, so their plots line up). */
export default function ChartHoverSync({ children }: { children: ReactNode }) {
  const state = useChartHoverState()
  const gutter = useChartGutterState()
  return (
    <ChartGutterContext.Provider value={gutter}>
      <ChartHoverContext.Provider value={state}>{children}</ChartHoverContext.Provider>
    </ChartGutterContext.Provider>
  )
}
