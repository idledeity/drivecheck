import { useMemo, useState } from "react"
import type { Drive } from "./types"
import { Control, Segmented } from "./Controls"
import DriveChip from "./DriveChip"
import ChartCard from "./charts/ChartCard"
import ChartHoverSync from "./charts/ChartHoverSync"
import TemperatureChart from "./charts/TemperatureChart"
import ThroughputChart from "./charts/ThroughputChart"
import { driveColorOrder, driveStyles } from "./charts/drivePalette"
import LineKey from "./charts/LineKey"
import { chartDrive, hottest, peakThroughput } from "./charts/historySeries"
import type { ChartDrive } from "./charts/historySeries"
import { dateLabel } from "./charts/scales"
import { HISTORY_RANGES, useDriveHistory } from "./charts/useDriveHistory"
import type { DriveHistoryData, HistoryRange } from "./charts/useDriveHistory"
import { formatThroughput } from "./format"
import "./TrendsPanel.css"

// Bucket width per range, as the chart subtitles say it ("average per 5 min").
const BUCKET_TEXT: Record<HistoryRange, string> = {
  "1h": "minute", "8h": "2 min", "24h": "5 min", "7d": "30 min", "30d": "2 h", "90d": "6 h",
}

/**
 * Health > Trends: the selected drives' recorded history on one time axis.
 * One filter row scopes every chart below it; hovering any chart moves the
 * crosshair in all of them. Each chart is a standalone component (charts/),
 * so the same views can appear elsewhere — e.g. a drive card's popover.
 */
export default function TrendsPanel({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  const [range, setRange] = useState<HistoryRange>("24h")
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showJobs, setShowJobs] = useState(true)
  // Fetch every selected drive, hidden or not, so toggling a chip is instant.
  const { data, stale, error } = useDriveHistory(selectedGuids, range)

  // The drive list is replaced on every 2s poll, but the charts only need each
  // drive's name. Keying on the names keeps `all` and `shown` the same arrays
  // between polls, so the (memoized) charts skip re-rendering until the
  // history itself changes — every 1 to 5 minutes.
  const names = selectedGuids.map(g => {
    const d = drives.find(x => x.guid === g)
    return d ? `${d.label ?? ""}|${d.model ?? ""}|${d.device}|${d.serial ?? ""}` : ""
  }).join("\n")
  const guidsKey = selectedGuids.join(",")
  // Colors come from each drive's place among all drives (first seen first),
  // so a drive keeps its color whatever else is selected, hidden or sorted.
  const colorKey = driveColorOrder(drives).join(",")
  const all = useMemo(() => {
    const guids = guidsKey ? guidsKey.split(",") : []
    const order = colorKey ? colorKey.split(",") : []
    // A selected drive the list doesn't know (yet) takes the next slot after it.
    const styles = driveStyles([...order, ...guids.filter(g => !order.includes(g))])
    return guids.map(g => chartDrive(g, drives.find(d => d.guid === g), styles[g]))
    // names and colorKey stand in for drives: only those fields are read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidsKey, names, colorKey])
  const shown = useMemo(() => {
    // If the selection changes so that only hidden drives remain, show them all.
    const visible = all.filter(d => !hidden.has(d.guid))
    return visible.length ? visible : all
  }, [all, hidden])

  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to view their trends.</p>
  }

  // The last shown drive can't be hidden, so the charts never go empty.
  const toggle = (guid: string) => setHidden(prev => {
    const next = new Set(prev)
    if (!shown.some(d => d.guid === guid)) next.delete(guid)
    else if (shown.length > 1) next.add(guid)
    return next
  })

  return (
    <div className="trends">
      <div className="filter-row">
        <Control label="Range">
          <Segmented label="Range" idPrefix="trends-range" value={range} onChange={setRange}
            options={HISTORY_RANGES.map(r => ({ value: r, label: r }))} />
        </Control>
        {/* Doubles as the charts' legend: each drive's chip leads with its line
            key. Shown even for one drive, so the charts always say whose they
            are. Inside a .drive-chip-list, so the chips shorten the serial
            (then drop the maker) when the row is narrow, as elsewhere. */}
        <div className="drive-chip-list trends-drives" role="group" aria-label="Drives shown">
          {all.map(d => (
            <button key={d.guid} className="trends-drive" aria-pressed={shown.includes(d)} onClick={() => toggle(d.guid)}>
              <DriveChip drive={drives.find(x => x.guid === d.guid)} lead={<LineKey {...d.style} />} />
            </button>
          ))}
        </div>
        <label className="ctl-check trends-jobs">
          <input type="checkbox" checked={showJobs} onChange={e => setShowJobs(e.target.checked)} />
          Show jobs
        </label>
      </div>

      {error && <p className="health-empty">Couldn't load history: {error}</p>}
      {!data && !error && <p className="health-empty">Loading history…</p>}

      {data && (
        <ChartHoverSync>
          <div className="trends-charts">
            <ChartCard
              title="Temperature"
              subtitle={`°C, average per ${BUCKET_TEXT[data.range]}, to the nearest 0.5`}
              callout={<HottestCallout data={data} drives={shown} />}
              stale={stale}
            >
              <TemperatureChart data={data} drives={shown} showJobs={showJobs} />
            </ChartCard>
            <ChartCard
              title="Throughput"
              subtitle={`MB/s read + write, average per ${BUCKET_TEXT[data.range]}`}
              callout={<PeakCallout data={data} drives={shown} />}
              stale={stale}
            >
              <ThroughputChart data={data} drives={shown} showJobs={showJobs} />
            </ChartCard>
          </div>
        </ChartHoverSync>
      )}
    </div>
  )
}

function HottestCallout({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const hot = hottest(data, drives)
  if (!hot) return <span className="muted">No readings in this range</span>
  return <>Hottest <b>{hot.value} °C</b> · {hot.drive.label} · {dateLabel(hot.t)}</>
}

function PeakCallout({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const peak = peakThroughput(data, drives)
  if (!peak || peak.value < 1e3) return <span className="muted">All drives idle in this range</span>
  return <>Peak <b>{formatThroughput(peak.value)}</b> · {peak.drive.label}</>
}
