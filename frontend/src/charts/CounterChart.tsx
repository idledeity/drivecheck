import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import ChartDriveChip from "./ChartDriveChip"
import type { ChartSeries } from "./TimeSeriesChart"
import { firstReadingMarkers } from "./healthChanges"
import { bucketLabel, counterThresholds, dataGaps, jobSpans, signalPoints } from "./historySeries"
import { counterFormat } from "./counters"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

// The least a linear counter axis spans, in counts (see the yInclude below).
const MIN_SPAN = 10

/** One counter (an error count such as reallocated sectors, or a wear count
 *  such as load/unload cycles) per drive, as the running total it is: a step
 *  line. Error counts default to a log1p scale, so a drive with a thousand
 *  reallocations doesn't flatten one with six onto the baseline, while 0 → 1
 *  (usually the step that matters) still shows clearly. A wear count is never
 *  near 0 and climbs steadily, so it reads better on a linear scale fitted to
 *  the data (scale="linear"), where drives separate and slopes show. Drives
 *  that don't report the counter get no line. Threshold lines far above the
 *  data are left off (counterThresholds); the chart's frame names them. Small: these are drawn as small multiples,
 *  so the job rail is shown but the tooltip leaves jobs out. */
function CounterChart({ data, drives, signal, label, scale = "log1p", showJobs = true, highlight = null, height = 130 }: {
  data: DriveHistoryData
  drives: ChartDrive[]
  /** The signal's key, e.g. "reallocated". */
  signal: string
  /** For the chart's accessible name, e.g. "Reallocated sectors". */
  label: string
  scale?: "log1p" | "linear"
  showJobs?: boolean
  /** A drive to bring forward (the others dim), e.g. while its legend chip is hovered. */
  highlight?: string | null
  height?: number
}) {
  const series: ChartSeries[] = drives.flatMap(d => {
    const points = signalPoints(data, d.guid, signal)
    return points.length ? [{
      id: d.guid,
      label: d.label,
      ...d.style,
      shape: "step" as const,
      tipLabel: <ChartDriveChip drive={d} />,
      points,
    }] : []
  })
  // Drives that don't report it: no line, but a row in the readings.
  const absent = drives.filter(d => !series.some(s => s.id === d.guid))
    .map(d => ({ id: d.guid, label: <ChartDriveChip drive={d} />, text: "not reported" }))
  const { inView: thresholds } = counterThresholds(data, drives, signal)
  // A fitted linear axis over a counter that barely moved (one drive, +1)
  // would span a single count: fractional ticks, and a +1 drawn as a cliff.
  // Keep it at least MIN_SPAN counts tall, centred on the data, never below 0.
  const include = thresholds.map(th => th.value)
  if (scale === "linear") {
    const values = series.flatMap(s => s.points.flatMap(p => (p.v === null ? [] : [p.v])))
    if (values.length) {
      const lo = Math.min(...values), hi = Math.max(...values)
      const pad = Math.max(0, (MIN_SPAN - (hi - lo)) / 2)
      include.push(Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad))
    }
  }

  return (
    <TimeSeriesChart
      ariaLabel={`${label} over time`}
      series={series}
      highlight={highlight}
      start={data.start}
      end={data.end}
      snapMs={data.bucketMs}
      height={height}
      yScale={scale}
      // Thresholds near the data, and a linear axis' least span (above).
      yInclude={include}
      thresholds={thresholds}
      spans={showJobs ? jobSpans(data, drives) : undefined}
      gaps={dataGaps(data, drives)}
      markers={firstReadingMarkers(data, drives, signal)}
      formatY={counterFormat(signal).axis}
      formatValue={(v, s) => <CounterReading v={v} base={baseOf(s)} format={counterFormat(signal).value} />}
      formatTime={t => bucketLabel(t, data.bucketMs)}
      absent={absent}
    />
  )
}

/** A series' value at the range start: its first point, the value carried
 *  in from before the range (or the first one recorded, if read in it). */
function baseOf(s: ChartSeries): number | null {
  return s.points.find(p => p.v !== null)?.v ?? null
}

/** A count in the readings, with how far it has moved since the range start
 *  (up to the time read, so it always agrees with the count beside it);
 *  nothing beside a count that hasn't moved. */
function CounterReading({ v, base, format }: { v: number; base: number | null; format: (v: number) => string }) {
  const d = base === null ? 0 : v - base
  return <>
    {format(v)}
    {d !== 0 && <span className="tsc-tip-delta" title="Change since the start of the range">{d > 0 ? "+" : "−"}{format(Math.abs(d))}</span>}
  </>
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives, job toggle or highlight do.
export default memo(CounterChart)
