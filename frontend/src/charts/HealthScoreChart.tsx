import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import type { ChartBand } from "./TimeSeriesChart"
import { healthChanges, healthMarkers } from "./healthChanges"
import { healthPoints, healthStatusAt } from "./historySeries"
import { absentRows, driveSeries, historyChartProps } from "./historyChart"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

/** Each drive's health score (0–100) as a step line — it holds until the next
 *  scoring changes it — over the status bands the score is judged by. The
 *  bands aren't labelled inside the plot, where the names sat on top of the
 *  lines; the chart's frame says which is which (HealthBandsKey). */
function HealthScoreChart({ data, drives, showJobs = true, listJobs = true, highlight = null, height = 150 }: {
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
  const { healthy_gte: healthy, aging_gte: aging, degraded_gte: degraded, failing_gte: failing } = data.thresholds.health
  const series = drives.flatMap(d => {
    const points = healthPoints(data, d.guid)
    return points.some(p => p.v !== null) ? [driveSeries(d, points, "step")] : []
  })
  // Drives never scored in the range (e.g. no SMART): a row in the readings.
  const absent = absentRows(drives, series, "not scored")
  // Headroom above 100, so a perfect score isn't drawn on the plot's edge.
  const top = 104
  const bands: ChartBand[] = [
    { from: healthy, to: top, tone: "ok" },
    { from: aging, to: healthy, tone: "aging" },
    { from: degraded, to: aging, tone: "warn" },
    { from: failing, to: degraded, tone: "crit" },
    { from: 0, to: failing, tone: "critical" },
  ]

  return (
    <TimeSeriesChart
      {...historyChartProps(data, drives, { showJobs, listJobs })}
      ariaLabel="Health score over time"
      series={series}
      highlight={highlight}
      height={height}
      yMin={0}
      yMax={top}
      // The band edges as ticks: where a score changes status. (100 would
      // crowd 95's label; the bands say where the top is.)
      yTicks={[0, failing, degraded, aging, healthy]}
      bands={bands}
      // Changes from a first reading: not the drive getting worse.
      markers={healthMarkers(healthChanges(data, drives))}
      absent={absent}
      formatValue={(v, s, t) => {
        // At the bucket's end, as the chart reads the score (TimeSeriesChart).
        const status = healthStatusAt(data, s.id, Math.min(t + data.bucketMs, data.end) - 1)
        return status ? `${v} · ${status}` : `${v}`
      }}
    />
  )
}

/** The bands' names and edges, in their status colors: for the chart's
 *  subtitle, in place of labels inside the plot. */
export function HealthBandsKey({ data }: { data: DriveHistoryData }) {
  const { healthy_gte: healthy, aging_gte: aging, degraded_gte: degraded, failing_gte: failing } = data.thresholds.health
  return (
    <span className="health-bands-key">
      <span className="tone-ok">Healthy ≥ {healthy}</span>
      {" · "}
      <span className="tone-aging">Aging {aging}–{healthy - 1}</span>
      {" · "}
      <span className="tone-warn">Degraded {degraded}–{aging - 1}</span>
      {" · "}
      <span className="tone-crit">Failing {failing}–{degraded - 1}</span>
      {" · "}
      <span className="tone-critical">Critical &lt; {failing}</span>
    </span>
  )
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives, job toggle or highlight do.
export default memo(HealthScoreChart)
