import { memo, useId, useMemo, useRef } from "react"
import type { ReactNode } from "react"
import { readingRow, useChartPick, useLeftGutter } from "./chartHover"
import { useWidth } from "./useWidth"
import { clockLabel, dateLabel, timeTicks } from "./scales"
import ChartDriveChip from "./ChartDriveChip"
import { bucketLabel, dataGaps, jobAt, jobSpans, signalPoints } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import { bucketStart, numeric, widen } from "./chartGeometry"
import type { ChartPoint } from "./chartGeometry"
import type { DriveHistoryData } from "./useDriveHistory"
import {
  RATE_BUCKET, ageLabel, baselineSpread, counterChanges, eventStatus, firstRecord, rateBuckets,
  netChange, rateStatus, ratioLabel, settledSince, stepValue,
} from "./counterTrends"
import type { CounterChange, CounterWindows, EventStatus, RateBucket, RateStatus } from "./counterTrends"
import { counterFormat } from "./counters"
import type { CounterFormat } from "./counters"
import { useChartPointer } from "./useChartPointer"
import { AxisScrub, LineGrip } from "./ChartGrips"
import "./CounterLanesChart.css"

// A counter's Events or Rate view: one lane per drive, on the same time axis
// (and, under a ChartHoverSync, the same left edge and crosshair) as the
// line charts. Each lane is headed by the drive and its status line.
//
// Events: each change as a marker — ▲ up, ▽ down — sized by the jump and
// fading with age; changes too close to tell apart merge into one marker
// carrying their sum. A tint runs from the last change to now: a long one
// says "settled", a short one "just moved".
//
// Rate: the net change per bucket as bars, over a band showing the middle
// half of the comparison buckets and a dashed line at their mean, so a rate
// running above or below its usual shows against it.
//
// Both shade the recent window the status lines speak of, and hatch the part
// of the range before a drive's counter was first recorded and wherever the
// drive has no data (see dataGaps). A lane is one drive's, so it shades only
// that drive's jobs, in its color.

const M = { right: 6 }
const LANE_H = { events: 22, rate: 30 }
const AXIS_H = 18
// In Events, a pointer this close (px) to a change lands on it.
const SNAP_PX = 10
// Markers closer than this (px) merge into one.
const MERGE_PX = 7
// A marker's "+N" label needs this much room before the next marker.
const LABEL_PX = 26

export type LaneStatus = { kind: "event"; status: EventStatus } | { kind: "wear"; status: RateStatus }

interface Lane {
  drive: ChartDrive
  points: ChartPoint[]
  changes: CounterChange[]
  status: LaneStatus | null
  buckets: RateBucket[]
}

interface LanesProps {
  data: DriveHistoryData
  drives: ChartDrive[]
  signal: string
  /** For the chart's accessible name, e.g. "Reallocated sectors". */
  label: string
  view: "events" | "rate"
  /** Whose status line the lanes carry: an error count's changes, or a wear count's rate. */
  kind: "event" | "wear"
  windows: CounterWindows
  /** Draw the running total faintly behind each lane. */
  showTotal?: boolean
  /** The running total's scale, as in the Total view. */
  log?: boolean
  showJobs?: boolean
  highlight?: string | null
  /** Head each lane with its drive's chip (off in a one-drive popover, which names the drive already). */
  chips?: boolean
}

function CounterLanesChart(props: LanesProps) {
  const { data, label, view, highlight = null } = props
  const { start, end } = data
  const id = useId()
  const uid = id.replace(/[^a-zA-Z0-9_-]/g, "")
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const width = useWidth(wrapRef)
  // No y labels of its own; under a ChartHoverSync it takes the group's
  // gutter, so its time axis lines up with the line charts above.
  const ML = useLeftGutter(id, 0)
  // The lanes, their status lines and everything drawn in them but the
  // hover, once per data and size: hovering re-renders this chart (through
  // the shared hover) with the same props, and only the crosshair or bar
  // band and the readings move.
  const L = useMemo(() => lanesLayout(props, width, ML, uid), [props, width, ML, uid])
  const { x, plotW, lanes, bucket, lastBucket, snap, changeTimes, changeBuckets, laneH, format } = L

  // ── hover ───────────────────────────────────────────────────────────────
  // Snaps to the start of the bucket the time falls in (as TimeSeriesChart):
  // the chart's own buckets for Events, the bars for Rate. In Events a
  // pointer near a change's marker lands on that change's bucket (the bucket
  // under the pointer would often miss it), and the arrow keys step between
  // changes.
  const ptr = useChartPointer({
    id, start, end, width, hostRef: wrapRef, wrapRef, tipRef, x,
    toT: px => start + ((px - ML) / plotW) * (end - start),
    place: t => {
      const px = x(t)
      let best: number | null = null
      for (const c of changeTimes) if (Math.abs(x(c) - px) <= SNAP_PX && (best === null || Math.abs(x(c) - px) < Math.abs(x(best) - px))) best = c
      return best === null ? snap(t) : Math.min(lastBucket, bucketStart(best, start, bucket))
    },
    step: (from, dir) => changeBuckets.length
      // Events: to the next (or previous) change; past the last one, stay.
      ? (dir > 0 ? changeBuckets.find(b => b > from) : changeBuckets.findLast(b => b < from)) ?? null
      : snap(from + dir * bucket),
    latest: () => lastBucket,
    // The group's newest time (see TimeSeriesChart), in the bucket holding
    // it. Reported in the data's own buckets, not Rate's wide bars, which
    // would pull every chart in the group back to the bar's start.
    newest: start + Math.max(0, Math.ceil((end - start) / data.bucketMs) - 1) * data.bucketMs,
    // A time from another chart in the group lands in whichever bar holds it.
    readAt: view === "rate" ? snap : undefined,
  })
  const { at: hoverBucket, hx, tipT: tipBucket, tipBelow, pinned, gripped } = ptr
  // The grip sits mid-bar in Rate (the hover is a band there), on the line in Events.
  const gripX = hoverBucket === null ? 0 : view === "rate" ? (hx + x(Math.min(end, hoverBucket + bucket))) / 2 : hx
  // The same in every lane.
  const hoverMark = hoverBucket === null ? null : view === "rate"
    ? <rect className={`clc-hover-band${pinned ? " pinned" : ""}`} x={hx} y={0} width={Math.max(1, x(Math.min(end, hoverBucket + bucket)) - hx)} height={laneH} />
    : <line className={`tsc-crosshair${gripped || pinned ? " grip" : ""}`} x1={hx} x2={hx} y1={0} y2={laneH} />

  return (
    <div
      ref={wrapRef}
      className="clc"
      data-chart=""
      role="group"
      aria-label={`${label}, ${view === "rate" ? "rate per drive" : "changes per drive"}`}
      tabIndex={0}
      {...ptr.events}
      onPointerLeave={ptr.onPointerLeave}
    >
      {L.parts.map(p => (
        <div key={p.guid} className="clc-lane">
          {p.head}
          <div className="clc-strip-wrap">
            {gripped && hoverBucket !== null && <LineGrip x={gripX} top={0} height={laneH} onDrag={ptr.scrubTo} />}
            <svg className={`clc-strip${p.dim}`} width={width} height={laneH} viewBox={`0 0 ${width} ${laneH}`} aria-hidden="true">
              {p.strip}
              {hoverMark}
            </svg>
          </div>
        </div>
      ))}

      <div className="clc-axis-wrap">
        <AxisScrub top={0} height={AXIS_H} onTime={ptr.scrubTo} />
        {L.axis}
      </div>

      {ptr.showTip && tipBucket !== null && (
        <div ref={tipRef} className={`tsc-tip${tipBelow ? " below" : pinned ? " pinned" : ""}`} role={ptr.isSource ? "status" : undefined}>
          <div className="tsc-tip-time">{bucketLabel(tipBucket, bucket)}</div>
          <TipRows lanes={lanes} absent={L.absent}
            view={view} t={tipBucket} bucket={bucket} end={end} format={format} keepEmpty={tipBelow} highlight={highlight} data={data} />
        </div>
      )}
    </div>
  )
}

export default memo(CounterLanesChart)

/** The lanes and everything drawn in them that doesn't follow the cursor:
 *  each lane's head (chip, status line) and strip (hatching, jobs, the
 *  recent window, the marks or bars, the total behind them), and the axis. */
function lanesLayout(props: LanesProps, width: number, ML: number, uid: string) {
  const { data, drives, signal, view, kind, windows, showTotal = false, log = true, showJobs = true, highlight = null, chips = true } = props
  const { start, end } = data
  const plotW = Math.max(40, width - ML - M.right)
  const x = (t: number) => ML + ((t - start) / (end - start || 1)) * plotW

  const bucket = view === "rate" ? RATE_BUCKET[data.range].ms : data.bucketMs
  const format = counterFormat(signal)
  const lanes: Lane[] = drives.flatMap(d => {
    const points = signalPoints(data, d.guid, signal)
    if (firstRecord(points) === null) return []
    const status: LaneStatus | null = kind === "event"
      ? wrapStatus("event", eventStatus(points, start, end, windows))
      : wrapStatus("wear", rateStatus(points, start, end, windows, RATE_BUCKET[data.range].ms))
    return [{ drive: d, points, changes: counterChanges(points), status, buckets: view === "rate" ? rateBuckets(points, start, end, bucket) : [] }]
  })
  const absent = drives.filter(d => !lanes.some(l => l.drive.guid === d.guid))
  // Rate bars share one scale across lanes, so heights compare between drives.
  // Square-root: a drive at a few a day still shows beside one at hundreds.
  const yMax = Math.max(1, ...lanes.flatMap(l => l.buckets.map(b => b.delta ?? 0)))

  const toBoxes = (spans: { start: number; end: number | null }[], minW: number) => mergeBoxes(spans.flatMap(sp => {
    const a = Math.max(ML, x(Math.max(sp.start, start))), b = Math.min(ML + plotW, x(Math.min(sp.end ?? end, end)))
    return b < ML || a > ML + plotW ? [] : [widen(a, b, minW, ML, ML + plotW)]
  }))
  const spans = showJobs ? jobSpans(data, drives) : []
  const gaps = dataGaps(data, drives).bySeries
  const recentX = Math.max(ML, x(windows.recentStart))

  const lastBucket = start + Math.max(0, Math.ceil((end - start) / bucket) - 1) * bucket
  const snap = (t: number) => Math.min(lastBucket, Math.max(start, bucketStart(t, start, bucket)))
  // Events: the buckets holding a change, any lane's, oldest first.
  const changeTimes = view === "events"
    ? lanes.flatMap(l => l.changes).map(c => c.t).filter(t => t >= start && t <= end)
    : []
  const changeBuckets = [...new Set(changeTimes.map(t => Math.min(lastBucket, bucketStart(t, start, bucket))))].sort((a, b) => a - b)

  const laneH = LANE_H[view]
  const parts = lanes.map((l, i) => {
    const color = l.drive.style.color
    const first = firstRecord(l.points)!
    const dim = highlight && l.drive.guid !== highlight ? " dim" : ""
    const hatch = `url(#${uid}-h${i})`
    return {
      guid: l.drive.guid,
      dim,
      head: (
        <div className={`clc-head${dim}`}>
          {chips && <ChartDriveChip drive={l.drive} />}
          {l.status && <span className="clc-status"><LaneStatusText lane={l.status} windowLabel={windows.label} end={end} format={format} /></span>}
        </div>
      ),
      strip: <>
        <defs>
          <pattern id={`${uid}-h${i}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line className="clc-hatch" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        {first > start && <rect x={ML} y={0} width={Math.max(0, x(first) - ML)} height={laneH} fill={hatch} />}
        {toBoxes(gaps[l.drive.guid] ?? [], 1).map((b, j) => <rect key={`gap-${j}`} x={b.x} y={0} width={b.w} height={laneH} fill={hatch} />)}
        {toBoxes(spans.filter(sp => sp.series === l.drive.guid), 2).map((b, j) => (
          <rect key={`job-${j}`} className="tsc-span tinted" x={b.x} y={0} width={b.w} height={laneH} style={{ fill: color }} />
        ))}
        <rect className="clc-recent" x={recentX} y={0} width={Math.max(0, ML + plotW - recentX)} height={laneH} />
        {view === "events"
          ? <EventMarks lane={l} x={x} start={start} end={end} plotEnd={ML + plotW} h={laneH} color={color} format={format} />
          : <RateBars lane={l} x={x} windows={windows} plotEnd={ML + plotW} h={laneH} yMax={yMax} color={color} />}
        {showTotal && <TotalBackdrop points={l.points} x={x} start={start} plotEnd={ML + plotW} h={laneH} log={log} />}
      </>,
    }
  })

  const xTicks = timeTicks(start, end, Math.max(2, Math.floor(plotW / 60)))
  const axis = (
    <svg className="clc-axis" width={width} height={AXIS_H} viewBox={`0 0 ${width} ${AXIS_H}`} aria-hidden="true">
      {xTicks.map(tk => {
        const tx = x(tk.t)
        if (tx < ML + 14 || tx > ML + plotW - 14) return null
        return (
          <g key={tk.t}>
            <line className="tsc-baseline" x1={tx} x2={tx} y1={0} y2={4} />
            <text className="tsc-tick" x={tx} y={AXIS_H - 4} textAnchor="middle">{tk.label}</text>
          </g>
        )
      })}
    </svg>
  )

  return { x, plotW, lanes, absent, bucket, lastBucket, snap, changeTimes, changeBuckets, laneH, format, parts, axis }
}


function wrapStatus<K extends LaneStatus["kind"]>(kind: K, status: Extract<LaneStatus, { kind: K }>["status"] | null): LaneStatus | null {
  return status ? ({ kind, status } as LaneStatus) : null
}

/** A drive's status line, e.g. "1,051 · +23 in last 24h" or "38/day · ↑ 3.2× usual". */
export function LaneStatusText({ lane, windowLabel, end, format = counterFormat("") }: {
  lane: LaneStatus; windowLabel: string; end: number; format?: CounterFormat
}): ReactNode {
  if (lane.kind === "event") {
    const s = lane.status
    const value = <b>{format.value(s.value)}</b>
    if (s.kind === "recent") {
      const moved = [s.up && format.signed(s.up), s.down && format.signed(-s.down)].filter(Boolean).join(" ")
      return <>{value} · <span className="clc-warn">{moved} in last {windowLabel}</span></>
    }
    if (s.kind === "last") {
      return <>{value} · <span className="clc-muted">last {format.signed(s.delta)} · {ageLabel(end - s.t)} ago</span></>
    }
    const what = s.value === 0 ? "0 throughout" : s.since !== null ? `unchanged since ${dateLabel(s.since)}` : "unchanged in range"
    return s.value === 0 ? <span className="clc-muted">{what}</span> : <>{value} · <span className="clc-muted">{what}</span></>
  }
  const s = lane.status
  const rate = <><b>{format.rate(s.perDay)}</b>/day</>
  const title = s.basePerDay !== null ? `last ${windowLabel}: ${format.rate(s.perDay)}/day · before: ${format.rate(s.basePerDay)}/day` : undefined
  const trend = {
    faster: <span className={format.workload ? "clc-muted" : "clc-warn"}>↑ {ratioLabel(s.ratio!)} usual</span>,
    slower: <span className="clc-muted">↓ {ratioLabel(s.ratio!)} usual</span>,
    usual: <span className="clc-muted">about usual</span>,
    new: <span className={format.workload ? "clc-muted" : "clc-warn"}>↑ none before</span>,
    none: <span className="clc-muted">none</span>,
    short: <span className="clc-muted">too little history to compare</span>,
  }[s.trend]
  return <span title={title}>{rate} · {trend}</span>
}

interface MarkGroup { x0: number; x1: number; t0: number; t1: number; delta: number; n: number; value: number }

function EventMarks({ lane, x, start, end, plotEnd, h, color, format }: {
  lane: Lane; x: (t: number) => number; start: number; end: number; plotEnd: number; h: number; color: string
  format: CounterFormat
}) {
  const cy = h / 2
  const first = firstRecord(lane.points)!
  const since = lane.status?.kind === "event" ? settledSince(lane.status.status, lane.points, start) : null
  const groups: MarkGroup[] = []
  for (const c of lane.changes) {
    if (c.t <= start) continue
    const px = x(c.t), g = groups.at(-1)
    if (g && px - g.x1 < MERGE_PX && Math.sign(c.delta) === Math.sign(g.delta)) {
      Object.assign(g, { x1: px, t1: c.t, delta: g.delta + c.delta, n: g.n + 1, value: c.value })
    } else {
      groups.push({ x0: px, x1: px, t0: c.t, t1: c.t, delta: c.delta, n: 1, value: c.value })
    }
  }
  return (
    <>
      <line className="clc-track" x1={x(Math.max(start, first))} x2={plotEnd} y1={cy} y2={cy} />
      {since !== null && <rect className="clc-settled" x={x(since)} y={cy - 4} width={Math.max(0, plotEnd - x(since))} height={8} rx={2} fill={color} />}
      {groups.map((g, i) => {
        // Older marks fade, down to 40%: recency shows before the axis is read.
        const opacity = 1 - 0.6 * ((end - g.t1) / (end - start || 1))
        const r = Math.min(8, 3.2 + 1.5 * Math.log2(1 + Math.abs(g.delta)))
        const cx = (g.x0 + g.x1) / 2, up = g.delta > 0
        const d = up
          ? `M${cx},${cy - r}L${cx + r},${cy + r * 0.8}L${cx - r},${cy + r * 0.8}Z`
          : `M${cx},${cy + r}L${cx + r},${cy - r * 0.8}L${cx - r},${cy - r * 0.8}Z`
        const next = groups[i + 1]
        const labelled = (Math.abs(g.delta) > 1 || g.n > 1) && (!next || next.x0 - g.x1 > LABEL_PX) && cx + r + LABEL_PX <= plotEnd + M.right
        const sign = up ? "+" : "−"
        return (
          <g key={g.t0} opacity={opacity}>
            <path className={`clc-mark${up ? "" : " down"}`} d={d} fill={up ? color : "var(--chart)"} stroke={color} />
            {labelled && <text className="clc-mark-label" x={cx + r + 3} y={cy + 3.5}>{sign}{format.value(Math.abs(g.delta))}</text>}
          </g>
        )
      })}
    </>
  )
}

function RateBars({ lane, x, windows, plotEnd, h, yMax, color }: {
  lane: Lane; x: (t: number) => number; windows: CounterWindows; plotEnd: number; h: number; yMax: number; color: string
}) {
  const y = (v: number) => h - 1 - Math.sqrt(Math.max(0, v) / yMax) * (h - 4)
  const spread = baselineSpread(lane.buckets, windows)
  const bx = x(windows.baseStart)
  return (
    <>
      {spread && <>
        <rect className="clc-band" x={bx} y={y(spread.hi)} width={plotEnd - bx} height={Math.max(1, y(spread.lo) - y(spread.hi))} />
        <line className="clc-mean" x1={bx} x2={plotEnd} y1={y(spread.mean)} y2={y(spread.mean)} />
      </>}
      <line className="tsc-baseline" x1={x(lane.buckets[0]?.start ?? 0)} x2={plotEnd} y1={h - 0.5} y2={h - 0.5} />
      {lane.buckets.map(b => b.delta !== null && b.delta > 0 && (
        <rect key={b.start} className={`clc-bar${b.start >= windows.recentStart ? " recent" : ""}`}
          x={x(b.start) + 0.5} y={y(b.delta)} width={Math.max(1, x(b.end) - x(b.start) - 1)} height={h - 1 - y(b.delta)} fill={color} />
      ))}
    </>
  )
}

/** The running total, faint, scaled to the lane: where the count stands
 *  behind the changes that moved it. */
function TotalBackdrop({ points, x, start, plotEnd, h, log }: {
  points: ChartPoint[]; x: (t: number) => number; start: number; plotEnd: number; h: number; log: boolean
}) {
  const f = log ? Math.log1p : (v: number) => v
  const pts = numeric(points)
  const vals = pts.map(p => f(p.v)), lo = Math.min(...vals), hi = Math.max(...vals)
  const y = (v: number) => (hi === lo ? h / 2 : h - 3 - ((f(v) - lo) / (hi - lo)) * (h - 6))
  let d = ""
  for (const p of pts) d += d ? `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}` : `M${x(Math.max(start, p.t)).toFixed(1)},${y(p.v).toFixed(1)}`
  return <path className="clc-total" d={`${d}H${plotEnd}`} />
}

/** The tooltip: per drive, the count at the end of the hovered bucket and its
 *  change in it (Events), or the bar's change (Rate). keepEmpty (under a
 *  narrow chart, in the page flow): a drive with nothing there keeps its row
 *  as "—", so the readings' height holds while scrubbing. */
function TipRows({ lanes, absent, view, t, bucket, end, format, keepEmpty, highlight, data }: {
  lanes: Lane[]
  /** Drives that don't report the counter: no lane, but a row here. */
  absent: ChartDrive[]
  view: "events" | "rate"; t: number; bucket: number; end: number; format: CounterFormat; keepEmpty: boolean
  highlight: string | null
  /** For the job running at a change. */
  data: DriveHistoryData
}) {
  const pick = useChartPick()
  const rows = lanes.flatMap((l): { drive: ChartDrive; text: string | null; detail?: ReactNode }[] => {
    const empty = keepEmpty ? [{ drive: l.drive, text: null }] : []
    if (view === "rate") {
      const b = l.buckets.find(q => q.start === t)
      return b && b.delta !== null ? [{ drive: l.drive, text: format.signed(b.delta) }] : empty
    }
    // The count as the bucket closes, and what changed within it.
    const e = Math.min(end, t + bucket)
    const to = stepValue(l.points, e >= end ? end : e - 1)
    if (to === null) return empty
    const changes = l.changes.filter(c => c.t >= t && (c.t < e || (e >= end && c.t <= end)))
    const delta = netChange(l.changes, t, e, end)
    const text = `${format.value(to)}${delta ? ` (${format.signed(delta)})` : ""}`
    // When it changed (the bucket header has the date), and what the drive
    // was doing then. Several changes in one bucket: how many, and the last.
    const last = changes.at(-1)
    const job = last ? jobAt(data, l.drive.guid, last.t) : null
    const detail = last && <span className="clc-tip-detail">
      {changes.length > 1 ? `${changes.length} changes, last ` : "at "}{clockLabel(last.t)}
      {job && <span className="clc-tip-job"> · {job}</span>}
    </span>
    return [{ drive: l.drive, text, detail }]
  })
  if (!rows.length && !absent.length) return <div className="tsc-tip-none">No data</div>
  return (
    <div className="tsc-tip-rows">
      {rows.map(r => {
        const row = readingRow(pick, r.drive.guid, highlight)
        return (
          <div key={r.drive.guid} className={`tsc-tip-row${row.cls}`} {...row.props}>
            <span className="tsc-tip-label"><ChartDriveChip drive={r.drive} /></span>
            <span className="tsc-tip-value">{r.text ?? <span className="tsc-tip-empty">—</span>}{r.detail}</span>
          </div>
        )
      })}
      {absent.map(d => {
        const row = readingRow(pick, d.guid, highlight)
        return (
          <div key={d.guid} className={`tsc-tip-row absent${row.cls}`} {...row.props}>
            <span className="tsc-tip-label"><ChartDriveChip drive={d} /></span>
            <span className="tsc-tip-value"><span className="tsc-tip-empty">not reported</span></span>
          </div>
        )
      })}
    </div>
  )
}

function mergeBoxes(boxes: { x: number; w: number }[]) {
  const out: { x: number; w: number }[] = []
  for (const b of [...boxes].sort((p, q) => p.x - q.x)) {
    const last = out.at(-1)
    if (last && b.x <= last.x + last.w) last.w = Math.max(last.w, b.x + b.w - last.x)
    else out.push({ ...b })
  }
  return out
}
