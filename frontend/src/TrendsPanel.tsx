import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { IconPinFilled, IconX } from "@tabler/icons-react"
import type { Drive } from "./types"
import { Control, Segmented } from "./Controls"
import DriveChip from "./DriveChip"
import ChartCard from "./charts/ChartCard"
import ChartHoverSync from "./charts/ChartHoverSync"
import { ChartHoverContext, ChartPickContext } from "./charts/chartHover"
import TemperatureChart from "./charts/TemperatureChart"
import ThroughputChart from "./charts/ThroughputChart"
import HealthScoreChart, { HealthBandsKey } from "./charts/HealthScoreChart"
import HealthChangeLog from "./charts/HealthChangeLog"
import CounterChart from "./charts/CounterChart"
import CounterLanesChart from "./charts/CounterLanesChart"
import CounterEventLog from "./charts/CounterEventLog"
import CounterViewControls, { BaselinePick, RecentPick } from "./charts/CounterViewControls"
import { COUNTER_SIGNALS, counterKind, counterScale, counterSubtitle, trendsCounterViews, useCounterView } from "./charts/counters"
import { RATE_BUCKET, counterWindows, windowFits } from "./charts/counterTrends"
import { driveColorOrder, driveStyles } from "./charts/drivePalette"
import LineKey from "./charts/LineKey"
import TrendsJobs from "./charts/TrendsJobs"
import { chartDrive, counterSummary, counterThresholds, healthSummary, hottest, peakThroughput } from "./charts/historySeries"
import type { ChartDrive } from "./charts/historySeries"
import { momentLabel } from "./charts/scales"
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
  const [pinned, setPinned] = usePinnedFilters()
  const trendsRef = useRef<HTMLDivElement>(null)
  usePageBelow(trendsRef, pinned)
  // The drive whose legend chip is hovered or focused: its line comes forward
  // in every chart (others dim), which also finds it where lines coincide.
  const [hovered, setHovered] = useState<string | null>(null)
  // A drive picked from the readings under any chart: highlighted in every
  // chart until its row is clicked again (another row moves the highlight).
  const [picked, setPicked] = useState<string | null>(null)
  // The drive whose readings row the mouse is over: previewed, unless a
  // drive is pinned. Leaving is a moment late, so crossing the gap between
  // a row's name and value (or into the next row) doesn't flicker.
  const [rowHovered, setRowHovered] = useState<string | null>(null)
  const leaveTimer = useRef<number | undefined>(undefined)
  const hoverRow = useCallback((guid: string | null) => {
    window.clearTimeout(leaveTimer.current)
    if (guid !== null) setRowHovered(guid)
    else leaveTimer.current = window.setTimeout(() => setRowHovered(null), 80)
  }, [])
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])
  const pickState = useMemo(() => ({
    picked,
    pick: (guid: string) => setPicked(p => (p === guid ? null : guid)),
    hover: hoverRow,
  }), [picked, hoverRow])
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

  // Hovering a drive's chip previews it over the picked one; hovering a
  // readings row previews it only while nothing is picked.
  const isShown = (g: string | null) => g !== null && shown.some(d => d.guid === g)
  const highlight = isShown(hovered) ? hovered : isShown(picked) ? picked : isShown(rowHovered) ? rowHovered : null

  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to view their trends.</p>
  }

  // The last shown drive can't be hidden, so the charts never go empty.
  const toggle = (guid: string) => {
    // Hiding the picked drive drops the pick, so showing it again doesn't
    // bring back a highlight nobody asked for.
    if (guid === picked && isShown(guid) && shown.length > 1) setPicked(null)
    setHidden(prev => {
      const next = new Set(prev)
      if (!shown.some(d => d.guid === guid)) next.delete(guid)
      else if (shown.length > 1) next.add(guid)
      return next
    })
  }

  return (
    // One hover group for the filter row too, so it can show (and clear) a
    // pinned time. Readings go under each chart, never floating over it: on
    // a page of charts a tooltip hides lines, and every chart's readings at
    // one time are what's worth seeing.
    <ChartHoverSync readingsBelow>
    <div ref={trendsRef} className={`trends${pinned ? " pinned" : ""}`}>
      <div className="filter-row">
        <Control label="Range">
          <Segmented label="Range" idPrefix="trends-range" value={range} onChange={setRange}
            options={HISTORY_RANGES.map(r => ({ value: r, label: r }))} />
        </Control>
        <PinnedTime />
        <div className="trends-checks">
          <label className="ctl-check trends-jobs">
            <input type="checkbox" checked={showJobs} onChange={e => setShowJobs(e.target.checked)} />
            Show jobs
          </label>
          <label className="ctl-check trends-pin" title="Keep these filters in view: the charts scroll in their own box below them">
            <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
            Pin filters
          </label>
        </div>
        {/* Doubles as the charts' legend: each drive's chip leads with its line
            key. Shown even for one drive, so the charts always say whose they
            are. Short chips on a full-width row of their own, so many drives
            wrap a few to a line rather than one per line. */}
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
              <DriveChip drive={drives.find(x => x.guid === d.guid)} lead={<LineKey {...d.style} />} serial="tail" short />
            </button>
          ))}
        </div>
        {data && showJobs && <TrendsJobs data={data} drives={shown} />}
      </div>

      {error && <p className="health-empty">Couldn't load history: {error}</p>}
      {!data && !error && <p className="health-empty">Loading history…</p>}

      {data && (
          <ChartPickContext.Provider value={pickState}>
          <div className="trends-charts">
            <ChartCard
              title="Temperature"
              subtitle={`°C, average per ${BUCKET_TEXT[data.range]}, to the nearest 0.5`}
              callout={<HottestCallout data={data} drives={shown} />}
              stale={stale}
            >
              <TemperatureChart data={data} drives={shown} showJobs={showJobs} listJobs={false} highlight={highlight} />
            </ChartCard>
            <ChartCard
              title="Throughput"
              subtitle={`MB/s read + write, average per ${BUCKET_TEXT[data.range]}`}
              callout={<PeakCallout data={data} drives={shown} />}
              stale={stale}
            >
              <ThroughputChart data={data} drives={shown} showJobs={showJobs} listJobs={false} highlight={highlight} />
            </ChartCard>
            <ChartCard
              title="Health score"
              subtitle={<HealthBandsKey data={data} />}
              callout={<HealthCallout data={data} drives={shown} />}
              stale={stale}
            >
              <HealthScoreChart data={data} drives={shown} showJobs={showJobs} listJobs={false} highlight={highlight} />
              <HealthChangeLog data={data} drives={shown} />
            </ChartCard>
            <div className="trends-counters">
              {COUNTER_SIGNALS.map(name => (
                <CounterCard key={name} name={name} data={data} drives={shown}
                  showJobs={showJobs} highlight={highlight} stale={stale} />
              ))}
            </div>
          </div>
          </ChartPickContext.Provider>
      )}
    </div>
    </ChartHoverSync>
  )
}

/** The time clicked to pin on the charts, with a button to unpin it (as a
 *  click on a chart or Escape do). Nothing while no time is pinned. */
function PinnedTime() {
  const hover = useContext(ChartHoverContext)
  if (!hover?.hover?.pinned) return null
  return (
    <button type="button" className="trends-pinned" onClick={() => hover.setHover(null)}
      title="Readings in every chart are at this time. Click a chart, press Escape or click here to unpin.">
      <IconPinFilled size={12} aria-hidden />
      Pinned {momentLabel(hover.hover.t)}
      <IconX size={12} aria-label="Unpin" />
    </button>
  )
}

const PIN_KEY = "trends.pinFilters"

/** Whether the filter row stays put over scrolling charts (the default) or
 *  scrolls away with the page. A layout preference, so it's remembered in
 *  this browser; storage can be unavailable, so it only ever falls back. */
function usePinnedFilters(): [boolean, (on: boolean) => void] {
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem(PIN_KEY) !== "0" } catch { return true }
  })
  return [pinned, on => {
    setPinned(on)
    try { localStorage.setItem(PIN_KEY, on ? "1" : "0") } catch { /* not remembered */ }
  }]
}

/** Pinned, the panel is a screen tall less whatever the page has below it
 *  (its containers' bottom padding, borders and margins), so scrolled to the
 *  end of the page the filter row's top lands at the top of the screen rather
 *  than past it. Measured, since those paddings change with the layout. */
function usePageBelow(ref: RefObject<HTMLDivElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!on || !el) return
    const measure = () => {
      let below = 0
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n)
        if (n !== el) below += parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)
        below += parseFloat(cs.marginBottom)
        // Anything after it in the same container sits below it too.
        for (let sib = n.nextElementSibling; sib; sib = sib.nextElementSibling) {
          below += sib.getBoundingClientRect().height
        }
      }
      el.style.setProperty("--trends-below", `${below}px`)
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [ref, on])
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

/** A count, not drives: which drives' scores moved is in the score change
 *  log under the chart. */
function HealthCallout({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const { dropped } = healthSummary(data, drives)
  const scored = drives.filter(d => data.drives[d.guid]?.health.some(h => h.pct !== null)).length
  if (!scored) return <span className="muted">Not scored in this range</span>
  if (!dropped.length) return <span className="muted">No drops in this range</span>
  return <><b>{dropped.length}</b> of {scored} drives fell</>
}


/** One counter's card, as its running total (the default), each change per
 *  drive, or its rate per drive against the usual. Left out when no charted
 *  drive reports the counter. A counter at 0 throughout still gets its full
 *  chart: a flat line reads as "nothing happened", where a missing chart
 *  would read as "no data". */
function CounterCard({ name, data, drives, showJobs, highlight, stale }: {
  name: string
  data: DriveHistoryData
  drives: ChartDrive[]
  showJobs: boolean
  highlight: string | null
  stale: boolean
}) {
  const [view, setView] = useCounterView(trendsCounterViews, name)
  // Events and Rate shade a recent window, and Rate compares it with the
  // rest of the range or the window before; each card picks its own, in its
  // subtitle. A window picked for a longer range reads as Auto until it fits.
  const recent = windowFits(view.recent, data.end - data.start) ? view.recent : "auto"
  const windows = useMemo(
    () => counterWindows(data.start, data.end, data.range, recent, view.baseline),
    [data, recent, view.baseline])
  const { changed, steady, firstRead } = counterSummary(data, drives, name)
  if (!changed.length && !steady.length) return null
  const title = SIGNALS[name]?.name ?? name
  // Thresholds too far above the data to draw are named in the subtitle.
  const { beyond } = counterThresholds(data, drives, name)
  const picks = { value: view, onChange: setView, range: data.range, rangeMs: data.end - data.start, idPrefix: `trends-${name}` }
  const subtitle = view.view === "total" ? counterSubtitle(name, beyond)
    : view.view === "events" ? <>Each change, sized by its jump · shaded: last <RecentPick {...picks} /></>
    : <>Change per {RATE_BUCKET[data.range].label} · shaded: last <RecentPick {...picks} /> · band: usual <BaselinePick {...picks} windowLabel={windows.label} /></>
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      controls={<CounterViewControls value={view} onChange={setView} label={title} idPrefix={`trends-${name}-view`} />}
      // A count, not drives: each drive's change since the range start is
      // beside its value in the readings under the chart.
      callout={changed.length
        ? <><b>{changed.length}</b> of {changed.length + steady.length} drives changed</>
        : firstRead.length
          ? <span className="muted">First read in this range · no change since</span>
          : <span className="muted">No change in this range</span>}
      stale={stale}
    >
      {view.view === "total"
        ? <CounterChart data={data} drives={drives} signal={name} label={title} scale={counterScale(name)} showJobs={showJobs} highlight={highlight} />
        : <CounterLanesChart data={data} drives={drives} signal={name} label={title} view={view.view} kind={counterKind(name)}
            windows={windows} showTotal={view.showTotal} log={counterScale(name) === "log1p"} showJobs={showJobs} highlight={highlight} />}
      {view.view === "events" && <CounterEventLog data={data} drives={drives} signal={name} highlight={highlight} />}
    </ChartCard>
  )
}
