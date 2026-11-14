import { useMemo, useState } from "react"
import type { Drive } from "./types"
import { Segmented } from "./Controls"
import TemperatureChart from "./charts/TemperatureChart"
import ThroughputChart from "./charts/ThroughputChart"
import HealthScoreChart, { HealthBandsKey } from "./charts/HealthScoreChart"
import CounterChart from "./charts/CounterChart"
import type { SeriesStyle } from "./charts/drivePalette"
import { chartDrive, counterSummary, counterThresholds, healthSummary, hottest, peakThroughput } from "./charts/historySeries"
import type { ChartDrive } from "./charts/historySeries"
import { HISTORY_RANGES, useDriveHistory } from "./charts/useDriveHistory"
import type { DriveHistoryData, HistoryRange } from "./charts/useDriveHistory"
import { formatThroughput } from "./format"
import { SIGNALS } from "./signals"
import { COUNTER_SIGNALS, counterScale, counterSubtitle } from "./charts/counters"
import type { CounterSignal } from "./charts/counters"
import "./DriveTrendPopover.css"

/** What a drive card value charts as: its two vitals, health, or one counter. */
export type TrendMetric = "temp" | "io" | "health" | CounterSignal


// The range last picked in any card popover, kept for the next one opened
// (this session only): someone comparing drives wants the same window each time.
let lastRange: HistoryRange = "24h"

/**
 * One drive's history of one card value, in the card's hover popover: the
 * same chart as Health > Trends, for this drive alone, with its own range
 * picker. Fetches while open (one drive, one range), refreshing like Trends.
 */
export default function DriveTrendPopover({ drive, style, metric }: { drive: Drive; style: SeriesStyle; metric: TrendMetric }) {
  const [range, setRangeState] = useState<HistoryRange>(lastRange)
  const setRange = (r: HistoryRange) => { lastRange = r; setRangeState(r) }
  const { data, stale, error } = useDriveHistory([drive.guid], range)

  // Stable while only the live fields change (the card re-renders on every
  // poll): the charts are memoized on it.
  const name = `${drive.label ?? ""}|${drive.model ?? ""}|${drive.device}|${drive.serial ?? ""}`
  const drives = useMemo(
    () => [chartDrive(drive.guid, drive, style)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drive.guid, name, style.color],
  )

  return (
    <div className={`dtp${stale ? " stale" : ""}`}>
      <div className="dtp-head">
        <span className="dtp-title">{TITLE[metric]}</span>
        <Segmented label="Range" value={range} onChange={setRange}
          options={HISTORY_RANGES.map(r => ({ value: r, label: r }))} />
      </div>
      {error && <div className="dtp-note">Couldn't load history: {error}</div>}
      {!data && !error && <div className="dtp-note">Loading…</div>}
      {data && <Body data={data} drives={drives} metric={metric} />}
    </div>
  )
}

const TITLE: Record<TrendMetric, string> = {
  temp: "Temperature",
  io: "Throughput",
  health: "Health score",
  ...Object.fromEntries(COUNTER_SIGNALS.map(s => [s, SIGNALS[s].name])) as Record<CounterSignal, string>,
}

function Body({ data, drives, metric }: { data: DriveHistoryData; drives: ChartDrive[]; metric: TrendMetric }) {
  if (metric === "temp") {
    const hot = hottest(data, drives)
    return <>
      <div className="dtp-sub">{hot ? <>°C · hottest <b>{hot.value} °C</b></> : "No readings in this range"}</div>
      <TemperatureChart data={data} drives={drives} height={150} />
    </>
  }
  if (metric === "io") {
    const peak = peakThroughput(data, drives)
    return <>
      <div className="dtp-sub">{peak && peak.value >= 1e3 ? <>MB/s read + write · peak <b>{formatThroughput(peak.value)}</b></> : "Idle in this range"}</div>
      <ThroughputChart data={data} drives={drives} height={130} />
    </>
  }
  if (metric === "health") {
    const { dropped } = healthSummary(data, drives)
    return <>
      <div className="dtp-sub">
        <HealthBandsKey data={data} />
        {dropped[0] && <> · fell <b>{dropped[0].from} → {dropped[0].to}</b></>}
      </div>
      <HealthScoreChart data={data} drives={drives} height={130} />
    </>
  }
  const { changed, missing } = counterSummary(data, drives, metric)
  if (missing.length) return <div className="dtp-note">No history of this counter for this drive.</div>
  const { beyond } = counterThresholds(data, drives, metric)
  const change = changed[0] && changed[0].to - changed[0].from
  return <>
    <div className="dtp-sub">
      {counterSubtitle(metric, beyond)}
      {" · "}
      {change ? <b>{change > 0 ? "+" : "−"}{Math.abs(change).toLocaleString()} in range</b> : "no change in range"}
    </div>
    <CounterChart data={data} drives={drives} signal={metric} label={TITLE[metric]}
      scale={counterScale(metric)} height={120} />
  </>
}
