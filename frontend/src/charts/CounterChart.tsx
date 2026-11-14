import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import ChartDriveChip from "./ChartDriveChip"
import type { ChartSeries } from "./TimeSeriesChart"
import { bucketLabel, counterThresholds, jobSpans, signalPoints } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

/** One counter (an error count such as reallocated sectors, or a wear count
 *  such as load/unload cycles) per drive, as the running total it is: a step
 *  line. Error counts default to a log1p scale, so a drive with a thousand
 *  reallocations doesn't flatten one with six onto the baseline, while 0 → 1
 *  (usually the step that matters) still shows clearly. A wear count is never
 *  near 0 and climbs steadily, so it reads better on a linear scale fitted to
 *  the data (scale="linear"), where drives separate and slopes show. Drives
 *  that don't report the counter get no line. Threshold lines far above the data are left off (counterThresholds);
 *  the chart's frame names them. Small: these are drawn as small multiples,
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
  const { inView: thresholds } = counterThresholds(data, drives, signal)

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
      // Keep the lines that are near the data in view (counterThresholds).
      yInclude={thresholds.map(th => th.value)}
      thresholds={thresholds}
      spans={showJobs ? jobSpans(data, drives) : undefined}
      formatValue={v => v.toLocaleString()}
      formatTime={t => bucketLabel(t, data.bucketMs)}
    />
  )
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives, job toggle or highlight do.
export default memo(CounterChart)
