import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import ChartDriveChip from "./ChartDriveChip"
import JobsDuring from "./JobsDuring"
import type { ChartBand, ChartSeries } from "./TimeSeriesChart"
import { bucketLabel, healthPoints, healthStatusAt, jobSpans, jobsDuring } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

/** Each drive's health score (0–100) as a step line — it holds until the next
 *  scoring changes it — over the status bands the score is judged by. The
 *  bands aren't labelled inside the plot, where the names sat on top of the
 *  lines; the chart's frame says which is which (HealthBandsKey). */
function HealthScoreChart({ data, drives, showJobs = true, highlight = null, height = 150 }: {
  data: DriveHistoryData
  drives: ChartDrive[]
  showJobs?: boolean
  /** A drive to bring forward (the others dim), e.g. while its legend chip is hovered. */
  highlight?: string | null
  height?: number
}) {
  const { healthy_gte: healthy, degraded_gte: degraded } = data.thresholds.health
  const series: ChartSeries[] = drives.map(d => ({
    id: d.guid,
    label: d.label,
    ...d.style,
    shape: "step",
    tipLabel: <ChartDriveChip drive={d} />,
    points: healthPoints(data, d.guid),
  }))
  // Headroom above 100, so a perfect score isn't drawn on the plot's edge.
  const top = 104
  const bands: ChartBand[] = [
    { from: healthy, to: top, tone: "ok" },
    { from: degraded, to: healthy, tone: "warn" },
    { from: 0, to: degraded, tone: "crit" },
  ]

  return (
    <TimeSeriesChart
      ariaLabel="Health score over time"
      series={series}
      highlight={highlight}
      start={data.start}
      end={data.end}
      snapMs={data.bucketMs}
      height={height}
      yMin={0}
      yMax={top}
      // The band edges as ticks: where a score changes status. (100 would
      // crowd 90's label; the bands say where the top is.)
      yTicks={[0, degraded, healthy]}
      bands={bands}
      spans={showJobs ? jobSpans(data, drives) : undefined}
      formatValue={(v, s, t) => {
        const status = healthStatusAt(data, s.id, t)
        return status ? `${v} · ${status}` : `${v}`
      }}
      formatTime={t => bucketLabel(t, data.bucketMs)}
      tooltipExtra={showJobs ? t => {
        const jobs = jobsDuring(data, drives, t)
        return jobs.length ? <JobsDuring jobs={jobs} /> : null
      } : undefined}
    />
  )
}

/** The bands' names and edges, in their status colors: for the chart's
 *  subtitle, in place of labels inside the plot. */
export function HealthBandsKey({ data }: { data: DriveHistoryData }) {
  const { healthy_gte: healthy, degraded_gte: degraded } = data.thresholds.health
  return (
    <span className="health-bands-key">
      <span className="tone-ok">Healthy ≥ {healthy}</span>
      {" · "}
      <span className="tone-warn">Degraded {degraded}–{healthy - 1}</span>
      {" · "}
      <span className="tone-crit">Failing &lt; {degraded}</span>
    </span>
  )
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives, job toggle or highlight do.
export default memo(HealthScoreChart)
