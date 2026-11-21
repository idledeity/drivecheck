import { useMemo, useState } from "react"
import type { Drive } from "./types"
import { Control, Segmented } from "./Controls"
import DriveChip from "./DriveChip"
import ChartCard from "./charts/ChartCard"
import ChartHoverSync from "./charts/ChartHoverSync"
import TemperatureChart from "./charts/TemperatureChart"
import ThroughputChart from "./charts/ThroughputChart"
import HealthScoreChart, { HealthBandsKey } from "./charts/HealthScoreChart"
import HealthChangeLog from "./charts/HealthChangeLog"
import CounterChart from "./charts/CounterChart"
import ChartDriveChip from "./charts/ChartDriveChip"
import CounterLanesChart from "./charts/CounterLanesChart"
import CounterViewControls from "./charts/CounterViewControls"
import { COUNTER_SIGNALS, counterFormat, counterKind, counterScale, counterSubtitle, trendsCounterViews, useCounterView } from "./charts/counters"
import { RATE_BUCKET, RECENT_WINDOWS, autoWindowLabel, counterWindows, windowFits } from "./charts/counterTrends"
import type { Baseline, CounterWindows, RecentWindow } from "./charts/counterTrends"
import { driveColorOrder, driveStyles } from "./charts/drivePalette"
import LineKey from "./charts/LineKey"
import { chartDrive, counterSummary, counterThresholds, healthSummary, hottest, peakThroughput } from "./charts/historySeries"
import type { ChartDrive } from "./charts/historySeries"
import { dateLabel, momentLabel } from "./charts/scales"
import { HISTORY_RANGES, useDriveHistory } from "./charts/useDriveHistory"
import type { DriveHistoryData, HistoryRange } from "./charts/useDriveHistory"
import { formatThroughput } from "./format"
import { SIGNALS } from "./signals"
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
  // The counters' Events and Rate views compare a recent window against the
  // rest of the range (or the window before it); one setting for every card,
  // so the same words mean the same thing in each.
  const [recent, setRecent] = useState<RecentWindow>("auto")
  const [baseline, setBaseline] = useState<Baseline>("rest")
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
  // A window picked for a longer range reads as Auto until it fits again.
  const rangeMs = data ? data.end - data.start : Infinity
  const recentShown: RecentWindow = windowFits(recent, rangeMs) ? recent : "auto"
  const windows = useMemo(
    () => (data ? counterWindows(data.start, data.end, data.range, recentShown, baseline) : null),
    [data, recentShown, baseline])

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
        <Control label="Recent" htmlFor="trends-recent">
          <select id="trends-recent" className="ctl-select" value={recentShown} onChange={e => setRecent(e.target.value as RecentWindow)}
            title="The window counter status lines and shading speak of">
            {RECENT_WINDOWS.map(w => (
              <option key={w} value={w} disabled={!windowFits(w, rangeMs)}>
                {w === "auto" ? `Auto (${autoWindowLabel(range)})` : `Last ${w}`}
              </option>
            ))}
          </select>
        </Control>
        <Control label="Compare with" htmlFor="trends-baseline">
          <select id="trends-baseline" className="ctl-select" value={baseline} onChange={e => setBaseline(e.target.value as Baseline)}>
            <option value="rest">Rest of range</option>
            <option value="prev">Window before</option>
          </select>
        </Control>
        <label className="ctl-check trends-jobs">
          <input type="checkbox" checked={showJobs} onChange={e => setShowJobs(e.target.checked)} />
          Show jobs
        </label>
      </div>

      {error && <p className="health-empty">Couldn't load history: {error}</p>}
      {!data && !error && <p className="health-empty">Loading history…</p>}

      {data && windows && (
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
              <HealthChangeLog data={data} drives={shown} />
            </ChartCard>
            <div className="trends-counters">
              {COUNTER_SIGNALS.map(name => (
                <CounterCard key={name} name={name} data={data} drives={shown} windows={windows} baseline={baseline}
                  showJobs={showJobs} highlight={highlight} stale={stale} />
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
  return <>Hottest <b>{hot.value} °C</b> · {hot.drive.label} · {momentLabel(hot.t)}</>
}

function PeakCallout({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const peak = peakThroughput(data, drives)
  if (!peak || peak.value < 1e3) return <span className="muted">All drives idle in this range</span>
  return <>Peak <b>{formatThroughput(peak.value)}</b> · {peak.drive.label} · {momentLabel(peak.t)}</>
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

/** One counter's card, as its running total (the default), each change per
 *  drive, or its rate per drive against the usual. Left out when no charted
 *  drive reports the counter. A counter at 0 throughout still gets its full
 *  chart: a flat line reads as "nothing happened", where a missing chart
 *  would read as "no data". */
function CounterCard({ name, data, drives, windows, baseline, showJobs, highlight, stale }: {
  name: string
  data: DriveHistoryData
  drives: ChartDrive[]
  windows: CounterWindows
  baseline: Baseline
  showJobs: boolean
  highlight: string | null
  stale: boolean
}) {
  const [view, setView] = useCounterView(trendsCounterViews, name)
  const { changed, steady, missing, firstRead } = counterSummary(data, drives, name)
  if (!changed.length && !steady.length) return null
  const title = SIGNALS[name]?.name ?? name
  // A drive with no signals at all (no SMART, e.g. a virtual disk) is named
  // once, under the health chart, rather than under every counter.
  const footer = notReported("Not reported by", missing.filter(d => hasSignals(data, d.guid)))
  // Thresholds too far above the data to draw are named in the subtitle.
  const { beyond } = counterThresholds(data, drives, name)
  const subtitle = view.view === "total" ? counterSubtitle(name, beyond)
    : view.view === "events" ? `Each change, sized by its jump · shaded: last ${windows.label}`
    : `Change per ${RATE_BUCKET[data.range].label} · band: usual ${baseline === "prev" ? `in the ${windows.label} before` : "earlier in range"} · shaded: last ${windows.label}`
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      controls={<CounterViewControls value={view} onChange={setView} label={title} idPrefix={`trends-${name}-view`} />}
      callout={changed.length ? (
        <span className="trends-callout">
          {changed.slice(0, CALLOUT_DRIVES).map(c => (
            <span key={c.drive.guid} className="trends-callout-item">
              <b>{c.to > c.from ? "+" : "−"}{Math.abs(c.to - c.from).toLocaleString()}</b> <ChartDriveChip drive={c.drive} />
            </span>
          ))}
          {changed.length > CALLOUT_DRIVES && <span>+{changed.length - CALLOUT_DRIVES} more</span>}
        </span>
      ) : firstRead.length ? (
        // Not "no change": the value wasn't known before it was first read.
        <span className="trends-callout">
          {firstRead.slice(0, CALLOUT_DRIVES).map(f => (
            <span key={f.drive.guid} className="trends-callout-item">
              <span>First read {dateLabel(f.t)}: <b>{counterFormat(name).value(f.value)}</b></span> <ChartDriveChip drive={f.drive} />
            </span>
          ))}
          {firstRead.length > CALLOUT_DRIVES && <span>+{firstRead.length - CALLOUT_DRIVES} more</span>}
          <span className="muted">· no change since</span>
        </span>
      ) : <span className="muted">No change in this range</span>}
      stale={stale}
      footer={footer}
    >
      {view.view === "total"
        ? <CounterChart data={data} drives={drives} signal={name} label={title} scale={counterScale(name)} showJobs={showJobs} highlight={highlight} />
        : <CounterLanesChart data={data} drives={drives} signal={name} label={title} view={view.view} kind={counterKind(name)}
            windows={windows} showTotal={view.showTotal} log={counterScale(name) === "log1p"} showJobs={showJobs} highlight={highlight} />}
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
