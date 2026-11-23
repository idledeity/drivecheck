import ChartDriveChip from "./ChartDriveChip"
import JobsDuring from "./JobsDuring"
import type { ChartPoint, ChartSeries } from "./chartGeometry"
import { bucketLabel, dataGaps, jobSpans, jobsDuring } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import type { DriveHistoryData } from "./useDriveHistory"

// What every drive-history chart hands TimeSeriesChart alike: one line per
// drive, named by its chip, and the range, buckets, jobs and gaps.

/** One drive's line: its id, label and style, its readings row led by its chip. */
export function driveSeries(drive: ChartDrive, points: ChartPoint[], shape?: "step"): ChartSeries {
  return { id: drive.guid, label: drive.label, ...drive.style, shape, tipLabel: <ChartDriveChip drive={drive} />, points }
}

/** Readings rows for the drives with no line, saying why (e.g. "not reported"). */
export function absentRows(drives: ChartDrive[], series: ChartSeries[], text: string) {
  return drives.filter(d => !series.some(s => s.id === d.guid))
    .map(d => ({ id: d.guid, label: <ChartDriveChip drive={d} />, text }))
}

/** The props every history chart shares: the range, snapping to its buckets
 *  (and a bucket as the readings' header), where there's no data, and the
 *  jobs, shaded and (with listJobs) listed in the readings. */
export function historyChartProps(data: DriveHistoryData, drives: ChartDrive[], { showJobs = true, listJobs = false } = {}) {
  return {
    start: data.start,
    end: data.end,
    snapMs: data.bucketMs,
    spans: showJobs ? jobSpans(data, drives) : undefined,
    gaps: dataGaps(data, drives),
    formatTime: (t: number) => bucketLabel(t, data.bucketMs),
    tooltipExtra: showJobs && listJobs
      ? (t: number, { compact }: { compact: boolean }) => <JobsDuring jobs={jobsDuring(data, drives, t)} compact={compact} />
      : undefined,
  }
}
