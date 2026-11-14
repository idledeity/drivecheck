import { useMemo, useState } from "react"
import type { Drive } from "./types"
import { Control, Segmented } from "./Controls"
import DriveChip from "./DriveChip"
import ChartCard from "./charts/ChartCard"
import ChartHoverSync from "./charts/ChartHoverSync"
import TemperatureChart from "./charts/TemperatureChart"
import ThroughputChart from "./charts/ThroughputChart"
import HealthScoreChart, { HealthBandsKey } from "./charts/HealthScoreChart"
import CounterChart from "./charts/CounterChart"
import ChartDriveChip from "./charts/ChartDriveChip"
import { driveColorOrder, driveStyles } from "./charts/drivePalette"
import LineKey from "./charts/LineKey"
import { chartDrive, counterSummary, counterThresholds, healthSummary, hottest, peakThroughput } from "./charts/historySeries"
import type { ChartDrive } from "./charts/historySeries"
import { dateLabel } from "./charts/scales"
import { HISTORY_RANGES, useDriveHistory } from "./charts/useDriveHistory"
import type { DriveHistoryData, HistoryRange } from "./charts/useDriveHistory"
import { formatThroughput } from "./format"
import { SIGNALS } from "./signals"
import "./TrendsPanel.css"

// The error counters charted as small multiples, in this order.
// Error counts first; load/unload cycles last, as the one wear count (head
// parking: normal use adds a few a day, an aggressive idle timer hundreds).
const COUNTERS = ["reallocated", "pending", "uncorrected", "crc_errors", "load_unload_cycles"]
// Wear counts: charted on a linear scale fitted to the data (see CounterChart).
const WEAR_COUNTERS = new Set(["load_unload_cycles"])

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
  // The drive whose legend chip is hovered or focused: its line comes forward
  // in every chart (others dim), which also finds it where lines coincide.
  const [hovered, setHovered] = useState<string | null>(null)
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

  const highlight = hovered && shown.some(d => d.guid === hovered) ? hovered : null

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
            <button
              key={d.guid}
              className="trends-drive"
              aria-pressed={shown.includes(d)}
              onClick={() => toggle(d.guid)}
              onPointerEnter={e => { if (e.pointerType === "mouse") setHovered(d.guid) }}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(d.guid)}
              onBlur={() => setHovered(null)}
            >
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
              <TemperatureChart data={data} drives={shown} showJobs={showJobs} highlight={highlight} />
            </ChartCard>
            <ChartCard
              title="Throughput"
              subtitle={`MB/s read + write, average per ${BUCKET_TEXT[data.range]}`}
              callout={<PeakCallout data={data} drives={shown} />}
              stale={stale}
            >
              <ThroughputChart data={data} drives={shown} showJobs={showJobs} highlight={highlight} />
            </ChartCard>
            <ChartCard
              title="Health score"
              subtitle={<HealthBandsKey data={data} />}
              callout={<HealthCallout data={data} drives={shown} />}
              stale={stale}
              footer={notReported("Not scored", shown.filter(d => !hasSignals(data, d.guid)))}
            >
              <HealthScoreChart data={data} drives={shown} showJobs={showJobs} highlight={highlight} />
            </ChartCard>
            <div className="trends-counters">
              {COUNTERS.map(name => (
                <CounterCard key={name} name={name} data={data} drives={shown} showJobs={showJobs} highlight={highlight} stale={stale} />
              ))}
            </div>
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

function HealthCallout({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const { dropped, lowest } = healthSummary(data, drives)
  if (dropped.length) {
    const [worst] = dropped
    return (
      <span className="trends-callout">
        <span className="trends-callout-item"><span>Fell <b>{worst.from} → {worst.to}</b></span><ChartDriveChip drive={worst.drive} /></span>
        {dropped.length > 1 && <span>+{dropped.length - 1} more</span>}
      </span>
    )
  }
  if (!lowest) return <span className="muted">Not scored in this range</span>
  return <span className="trends-callout"><span className="trends-callout-item"><span>Lowest <b>{lowest.value}</b></span><ChartDriveChip drive={lowest.drive} /></span></span>
}

// How many changed drives a counter's callout names before "+N more".
const CALLOUT_DRIVES = 2

/** One error counter's card. Left out when no charted drive reports the
 *  counter; just a line, with no chart, when it's 0 throughout on every drive
 *  that does — an empty baseline says nothing a sentence can't. */
function CounterCard({ name, data, drives, showJobs, highlight, stale }: {
  name: string
  data: DriveHistoryData
  drives: ChartDrive[]
  showJobs: boolean
  highlight: string | null
  stale: boolean
}) {
  const { changed, steady, missing } = counterSummary(data, drives, name)
  const reporting = changed.length + steady.length
  if (!reporting) return null
  const title = SIGNALS[name]?.name ?? name
  const allZero = !changed.length && steady.every(c => c.to === 0)
  // A drive with no signals at all (no SMART, e.g. a virtual disk) is named
  // once, under the health chart, rather than under every counter.
  const footer = notReported("Not reported by", missing.filter(d => hasSignals(data, d.guid)))
  // Thresholds too far above the data to draw are named in the subtitle.
  const { beyond } = counterThresholds(data, drives, name)
  if (allZero) {
    return (
      <ChartCard
        title={title}
        subtitle={reporting === 1 ? "0 throughout" : `0 throughout, on all ${reporting} drives that report it`}
        stale={stale}
        footer={footer}
      />
    )
  }
  return (
    <ChartCard
      title={title}
      subtitle={[WEAR_COUNTERS.has(name) ? "Running total" : "Running total, log scale", ...beyond.map(th => th.label)].join(" · ")}
      callout={changed.length ? (
        <span className="trends-callout">
          {changed.slice(0, CALLOUT_DRIVES).map(c => (
            <span key={c.drive.guid} className="trends-callout-item">
              <b>{c.to > c.from ? "+" : "−"}{Math.abs(c.to - c.from).toLocaleString()}</b> <ChartDriveChip drive={c.drive} />
            </span>
          ))}
          {changed.length > CALLOUT_DRIVES && <span>+{changed.length - CALLOUT_DRIVES} more</span>}
        </span>
      ) : <span className="muted">No change in this range</span>}
      stale={stale}
      footer={footer}
    >
      <CounterChart data={data} drives={drives} signal={name} label={title} scale={WEAR_COUNTERS.has(name) ? "linear" : "log1p"} showJobs={showJobs} highlight={highlight} />
    </ChartCard>
  )
}

/** Whether a drive has any recorded signals in the range. */
function hasSignals(data: DriveHistoryData, guid: string): boolean {
  return Object.values(data.drives[guid]?.signals ?? {}).some(points => points.length > 0)
}

/** A chart footnote naming drives the chart has no line for (none: no footnote). */
function notReported(label: string, drives: ChartDrive[]) {
  if (!drives.length) return undefined
  return <><span className="trends-foot-label">{label}</span>{drives.map(d => <ChartDriveChip key={d.guid} drive={d} />)}</>
}
