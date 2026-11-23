import { useState } from "react"
import type { ChartThreshold } from "./TimeSeriesChart"
import type { Baseline, CounterView, RecentWindow } from "./counterTrends"
import { rateLabel } from "./counterTrends"
import { formatBytes } from "../format"
import { formatTick } from "./scales"

// The counters charted wherever drive history is (Health > Trends, drive card
// popovers): error counts first (link errors count since power-on, so they
// can fall), then the wear counts: load/unload cycles (head parking: normal use
// adds a few a day, an aggressive idle timer hundreds) and data written.
export const COUNTER_SIGNALS = ["reallocated", "pending", "uncorrected", "crc_errors", "link_errors",
                                "load_unload_cycles", "data_written"] as const
export type CounterSignal = typeof COUNTER_SIGNALS[number]

export const isCounter = (signal: string): signal is CounterSignal =>
  (COUNTER_SIGNALS as readonly string[]).includes(signal)

/** Whether a drive card footer signal has a history chart (power-on hours,
 *  for one, has none). */
export const hasTrend = (signal: string): signal is CounterSignal | "temp" => signal === "temp" || isCounter(signal)

// Wear counts are never near 0 and climb steadily: a linear scale fitted to
// the data separates drives and shows slopes. Error counts use log1p, so
// 0 → 1 shows next to a drive with thousands (see CounterChart).
const WEAR_COUNTERS = new Set<string>(["load_unload_cycles", "data_written", "data_read"])

// Counters in bytes: workload, not wear or errors, so a faster rate than
// usual is no warning.
const BYTE_COUNTERS = new Set<string>(["data_written", "data_read"])

/** How a counter's values, changes and rates read. */
export interface CounterFormat {
  value: (v: number) => string
  /** A y-axis tick. */
  axis: (v: number) => string
  rate: (perDay: number) => string
  /** A change, signed: "+3", "−1.2 GB" (0 unsigned). */
  signed: (delta: number) => string
  /** A rate above usual is only more use, not a warning. */
  workload: boolean
}

const signedBytes = (v: number) => `${v < 0 ? "−" : ""}${formatBytes(Math.abs(v))}`

export function counterFormat(signal: string): CounterFormat {
  const f = BYTE_COUNTERS.has(signal)
    ? { value: signedBytes, axis: signedBytes, rate: signedBytes, workload: true }
    : { value: (v: number) => v.toLocaleString(), axis: formatTick, rate: rateLabel, workload: false }
  return { ...f, signed: d => `${d > 0 ? "+" : d < 0 ? "−" : ""}${f.value(Math.abs(d))}` }
}

export const counterScale = (signal: string): "linear" | "log1p" => (WEAR_COUNTERS.has(signal) ? "linear" : "log1p")

/** What a counter's status line speaks of: an error count's changes, or a wear count's rate. */
export const counterKind = (signal: string): "event" | "wear" => (WEAR_COUNTERS.has(signal) ? "wear" : "event")

/** A counter chart's subtitle: the scale, plus any threshold too far above
 *  the data to draw (counterThresholds' `beyond`). */
export function counterSubtitle(signal: string, beyond: ChartThreshold[]): string {
  return [counterScale(signal) === "linear" ? "Running total" : "Running total, log scale", ...beyond.map(th => th.label)].join(" · ")
}

/** How one counter card is viewed: Total (the default — the count itself
 *  matters most for health), Events or Rate, whether the running total is
 *  drawn faintly behind the last two, and (Trends only; a popover follows
 *  the range) the recent window they shade and what Rate compares it with. */
export interface CounterViewState { view: CounterView; showTotal: boolean; recent: RecentWindow; baseline: Baseline }

const DEFAULT_VIEW: CounterViewState = { view: "total", showTotal: false, recent: "auto", baseline: "rest" }

/** Each counter's last view, kept for this session (module state: it survives
 *  switching tabs or closing a popover, not a reload). Health > Trends and the
 *  drive card popovers each keep their own. */
export type CounterViewMemory = Map<string, CounterViewState>
export const trendsCounterViews: CounterViewMemory = new Map()
export const popoverCounterViews: CounterViewMemory = new Map()

export function useCounterView(memory: CounterViewMemory, signal: string): [CounterViewState, (next: CounterViewState) => void] {
  const [state, setState] = useState(() => memory.get(signal) ?? DEFAULT_VIEW)
  return [state, next => { memory.set(signal, next); setState(next) }]
}
