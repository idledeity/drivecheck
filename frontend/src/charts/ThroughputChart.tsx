import { memo } from "react"
import TimeSeriesChart from "./TimeSeriesChart"
import { vitalAt } from "./historySeries"
import { driveSeries, historyChartProps } from "./historyChart"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"
import { formatThroughput } from "../format"

/** Each drive's disk throughput (read + write) averaged per bucket: one line
 *  per drive rather than separate read and write lines, since with several
 *  drives charted doubled lines are unreadable — the tooltip gives the split. */
function ThroughputChart({ data, drives, showJobs = true, listJobs = true, highlight = null, height = 160 }: {
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
  const series = drives.map(d => {
    const v = data.drives[d.guid]?.vitals
    return driveSeries(d, v ? v.t.map((t, i) => ({ t, v: (v.read_bps[i] ?? 0) + (v.write_bps[i] ?? 0) })) : [])
  })

  return (
    <TimeSeriesChart
      {...historyChartProps(data, drives, { showJobs, listJobs })}
      ariaLabel="Disk throughput over time"
      series={series}
      highlight={highlight}
      height={height}
      yMin={0}
      // At least 1 MB/s tall, so idle drives sit on the baseline instead of
      // a few KB/s of background reads filling the chart.
      yInclude={[1e6]}
      formatY={v => `${+(v / 1e6).toFixed(1)}`}
      formatValue={(v, s, t) => {
        if (v < 1e3) return "idle"
        const read = vitalAt(data, s.id, "read_bps", t) ?? 0
        const write = vitalAt(data, s.id, "write_bps", t) ?? 0
        // Name the direction when one clearly dominates; otherwise give both.
        if (write < v * 0.1) return `${formatThroughput(v)} read`
        if (read < v * 0.1) return `${formatThroughput(v)} write`
        return `${formatThroughput(read)} read · ${formatThroughput(write)} write`
      }}
    />
  )
}

// Memoized: the panel re-renders on every 2s poll, but this chart only
// changes when its history data, drives or job toggle do.
export default memo(ThroughputChart)
