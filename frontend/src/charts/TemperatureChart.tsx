import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import { firstReadingMarkers } from "./healthChanges"
import { roundTemp } from "./historySeries"
import { driveSeries, historyChartProps } from "./historyChart"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

/** Each drive's average temperature per bucket, to the nearest 0.5 °C (see
 *  roundTemp), with the warning threshold the health score uses. The tooltip
 *  gives the same average: the bucket's min/max were more noise than help. */
function TemperatureChart({ data, drives, showJobs = true, listJobs = true, highlight = null, height = 200 }: {
  data: DriveHistoryData
  drives: ChartDrive[]
  showJobs?: boolean
  /** The jobs running at the hovered time, in the readings. Off where the
   *  page lists them once for all its charts (Trends' TrendsJobs). */
  listJobs?: boolean
  /** A drive to bring forward (the others dim), e.g. while its legend chip is hovered. */
  highlight?: string | null
  height?: number
}) {
  const warn = data.thresholds.signals.temp?.warn_gte ?? null
  const series = drives.map(d => {
    const v = data.drives[d.guid]?.vitals
    return driveSeries(d, v ? v.t.map((t, i) => ({ t, v: roundTemp(v.temp_avg[i]) })) : [])
  })

  return (
    <TimeSeriesChart
      {...historyChartProps(data, drives, { showJobs, listJobs })}
      ariaLabel="Temperature over time"
      series={series}
      highlight={highlight}
      height={height}
      // Keep the warning line in view (with a little headroom) even while
      // every drive runs well below it, so "how close" reads at a glance.
      yInclude={warn === null ? undefined : [warn + 2]}
      thresholds={warn === null ? undefined : [{ value: warn, label: `${warn} °C warning`, tone: "warn" }]}
      markers={firstReadingMarkers(data, drives, "temp")}
      formatY={v => `${v}°`}
      formatValue={v => `${v.toFixed(1)} °C`}
    />
  )
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives or job toggle do.
export default memo(TemperatureChart)
