import type { ChartThreshold } from "./TimeSeriesChart"

// The counters charted wherever drive history is (Health > Trends, drive card
// popovers): error counts first, then load/unload cycles, the one wear count
// (head parking: normal use adds a few a day, an aggressive idle timer hundreds).
export const COUNTER_SIGNALS = ["reallocated", "pending", "uncorrected", "crc_errors", "load_unload_cycles"] as const
export type CounterSignal = typeof COUNTER_SIGNALS[number]

export const isCounter = (signal: string): signal is CounterSignal =>
  (COUNTER_SIGNALS as readonly string[]).includes(signal)

/** Whether a drive card footer signal has a history chart (power-on hours,
 *  for one, has none). */
export const hasTrend = (signal: string): signal is CounterSignal | "temp" => signal === "temp" || isCounter(signal)

// Wear counts are never near 0 and climb steadily: a linear scale fitted to
// the data separates drives and shows slopes. Error counts use log1p, so
// 0 → 1 shows next to a drive with thousands (see CounterChart).
const WEAR_COUNTERS = new Set<string>(["load_unload_cycles"])

export const counterScale = (signal: string): "linear" | "log1p" => (WEAR_COUNTERS.has(signal) ? "linear" : "log1p")

/** A counter chart's subtitle: the scale, plus any threshold too far above
 *  the data to draw (counterThresholds' `beyond`). */
export function counterSubtitle(signal: string, beyond: ChartThreshold[]): string {
  return [counterScale(signal) === "linear" ? "Running total" : "Running total, log scale", ...beyond.map(th => th.label)].join(" · ")
}
