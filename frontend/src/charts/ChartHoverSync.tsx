import type { ReactNode } from "react"
import { ChartHoverContext, useChartHoverState } from "./chartHover"

/** Wrap charts that share a time axis to move their crosshairs together. */
export default function ChartHoverSync({ children }: { children: ReactNode }) {
  const state = useChartHoverState()
  return <ChartHoverContext.Provider value={state}>{children}</ChartHoverContext.Provider>
}
