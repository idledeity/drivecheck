import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import DriveChip from "../DriveChip"
import JobsDuring from "./JobsDuring"
import LineKey from "./LineKey"
import type { ChartSeries } from "./TimeSeriesChart"
import { bucketLabel, jobSpans, jobsDuring, roundTemp, vitalAt } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

/** Each drive's average temperature per bucket, to the nearest 0.5 °C (see
 *  roundTemp), with the warning threshold the health score uses. The tooltip
 *  adds the bucket's range of readings when they varied — a short spike shows
 *  there even when the line is smooth. */
function TemperatureChart({ data, drives, showJobs = true, height = 200 }: {
  data: DriveHistoryData
  drives: ChartDrive[]
  showJobs?: boolean
  height?: number
}) {
  const warn = data.thresholds.signals.temp?.warn_gte ?? null
  const series: ChartSeries[] = drives.map(d => {
    const v = data.drives[d.guid]?.vitals
    return {
      id: d.guid,
      label: d.label,
      ...d.style,
      tipLabel: <DriveChip drive={d.drive} serial="tail" thin lead={<LineKey {...d.style} />} />,
      points: v ? v.t.map((t, i) => ({ t, v: roundTemp(v.temp_avg[i]) })) : [],
    }
  })

  return (
    <TimeSeriesChart
      ariaLabel="Temperature over time"
      series={series}
      start={data.start}
      end={data.end}
      snapMs={data.bucketMs}
      height={height}
      // Keep the warning line in view (with a little headroom) even while
      // every drive runs well below it, so "how close" reads at a glance.
      yInclude={warn === null ? undefined : [warn + 2]}
      thresholds={warn === null ? undefined : [{ value: warn, label: `${warn} °C warning`, tone: "warn" }]}
      spans={showJobs ? jobSpans(data, drives) : undefined}
      formatY={v => `${v}°`}
      formatValue={(v, s, t) => {
        const min = vitalAt(data, s.id, "temp_min", t)
        const max = vitalAt(data, s.id, "temp_max", t)
        // A .5 already says "between these two degrees", so its range is only
        // worth showing when the readings spread wider than that.
        const implied = v % 1 !== 0 && min === Math.floor(v) && max === Math.ceil(v)
        const range = min !== null && max !== null && max > min && !implied ? ` (${min}–${max})` : ""
        return `${v.toFixed(1)} °C${range}`
      }}
      formatTime={t => bucketLabel(t, data.bucketMs)}
      tooltipExtra={showJobs ? t => {
        const jobs = jobsDuring(data, drives, t)
        return jobs.length ? <JobsDuring jobs={jobs} /> : null
      } : undefined}
    />
  )
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives or job toggle do.
export default memo(TemperatureChart)
