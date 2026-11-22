import { memo, useCallback, useId, useLayoutEffect, useRef } from "react"
import type { KeyboardEvent, PointerEvent, ReactNode } from "react"
import { onReadings, useChartHover, useGroupLatest, useLeftGutter } from "./chartHover"
import type { HoverFlags } from "./chartHover"
import { useWidth } from "./useWidth"
import { timeTicks } from "./scales"
import ChartDriveChip from "./ChartDriveChip"
import { bucketLabel, jobSpans, signalPoints } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import type { ChartPoint } from "./chartGeometry"
import type { DriveHistoryData } from "./useDriveHistory"
import {
  RATE_BUCKET, ageLabel, baselineSpread, counterChanges, eventStatus, firstRecord, rateBuckets,
  netChange, rateStatus, ratioLabel, settledSince, stepValue,
} from "./counterTrends"
import type { CounterWindows, EventStatus, RateBucket, RateStatus } from "./counterTrends"
import { counterFormat } from "./counters"
import type { CounterFormat } from "./counters"
import { useTapOutside, useTouchTap } from "./chartTouch"
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
// of the range before a drive's counter was first recorded.

const M = { right: 6 }
const LANE_H = { events: 22, rate: 30 }
const AXIS_H = 18
// Markers closer than this (px) merge into one.
const MERGE_PX = 7
// A marker's "+N" label needs this much room before the next marker.
const LABEL_PX = 26
const TIP_BELOW_WIDTH = 520

export type LaneStatus = { kind: "event"; status: EventStatus } | { kind: "wear"; status: RateStatus }

interface Lane {
  drive: ChartDrive
  points: ChartPoint[]
  status: LaneStatus | null
  buckets: RateBucket[]
}

function CounterLanesChart({ data, drives, signal, label, view, kind, windows, showTotal = false, log = true, showJobs = true, highlight = null, chips = true }: {
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
}) {
  const { start, end } = data
  const id = useId()
  const uid = id.replace(/[^a-zA-Z0-9_-]/g, "")
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const width = useWidth(wrapRef)
  const { hover, setHover } = useChartHover()
  // No y labels of its own; under a ChartHoverSync it takes the group's
  // gutter, so its time axis lines up with the line charts above.
  const ML = useLeftGutter(id, 0)
  const plotW = Math.max(40, width - ML - M.right)
  const x = (t: number) => ML + ((t - start) / (end - start || 1)) * plotW
  const toT = (px: number) => start + ((px - ML) / plotW) * (end - start)

  const bucket = view === "rate" ? RATE_BUCKET[data.range].ms : data.bucketMs
  const format = counterFormat(signal)
  const lanes: Lane[] = drives.flatMap(d => {
    const points = signalPoints(data, d.guid, signal)
    if (firstRecord(points) === null) return []
    const status: LaneStatus | null = kind === "event"
      ? wrapStatus("event", eventStatus(points, start, end, windows))
      : wrapStatus("wear", rateStatus(points, start, end, windows, RATE_BUCKET[data.range].ms))
    return [{ drive: d, points, status, buckets: view === "rate" ? rateBuckets(points, start, end, bucket) : [] }]
  })
  // Rate bars share one scale across lanes, so heights compare between drives.
  // Square-root: a drive at a few a day still shows beside one at hundreds.
  const yMax = Math.max(1, ...lanes.flatMap(l => l.buckets.map(b => b.delta ?? 0)))

  const jobs = showJobs ? mergeBoxes(jobSpans(data, drives).flatMap(sp => {
    const a = Math.max(ML, x(Math.max(sp.start, start))), b = Math.min(ML + plotW, x(Math.min(sp.end ?? end, end)))
    return b < ML || a > ML + plotW ? [] : [{ x: a, w: Math.max(2, b - a) }]
  })) : []
  const recentX = Math.max(ML, x(windows.recentStart))

  // ── hover ───────────────────────────────────────────────────────────────
  // Snaps to a bucket start: the chart's own buckets for Events, the bars for Rate.
  const lastBucket = start + Math.max(0, Math.ceil((end - start) / bucket) - 1) * bucket
  const snap = (t: number) => {
    const k = view === "rate" ? Math.floor((t - start) / bucket) : Math.round((t - start) / bucket)
    return Math.min(lastBucket, Math.max(start, start + k * bucket))
  }
  const hoverAt = (t: number | null, flags: HoverFlags = {}) => setHover(t === null ? null : { t, source: id, ...flags })
  const clientT = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    return toT(((clientX - r.left) / (r.width || width)) * width)
  }
  // Mouse and pen hover, and a click pins the time (or unpins it, back to
  // following the pointer); touch only taps (see chartTouch). A tap or click
  // on the readings is just reading them.
  const pinned = !!hover?.pinned
  const tap = useTouchTap(e => {
    if (!onReadings(e.target)) hoverAt(snap(clientT(e.clientX)), { touch: true })
  })
  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch" && !pinned && !onReadings(e.target)) hoverAt(snap(clientT(e.clientX)))
  }
  const onPress = (e: PointerEvent<HTMLDivElement>) => {
    tap.down(e)
    if (e.pointerType === "touch" || e.button !== 0 || onReadings(e.target)) return
    hoverAt(snap(clientT(e.clientX)), { pinned: !pinned })
  }
  // A reading placed by touch: its line can be grabbed in every chart that
  // draws it, and a tap outside the charts clears it (watched by the chart
  // that placed it).
  const gripped = !!hover?.touch
  const clearHover = useCallback(() => setHover(null), [setHover])
  useTapOutside(gripped && hover.source === id, clearHover)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") return hoverAt(null)
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    hoverAt(snap((hover?.t ?? lastBucket) + (e.key === "ArrowRight" ? bucket : -bucket)), { pinned })
  }
  const hoverT = hover && hover.t >= start && hover.t <= end ? hover.t : null
  // A time from another chart in the group lands in whichever bar holds it.
  const hoverBucket = hoverT === null ? null : view === "rate" ? snap(hoverT) : hoverT
  const tipBelow = width < TIP_BELOW_WIDTH
  // Narrow charts always show their readings: the hovered bucket's, else the newest.
  // The group's newest time (see TimeSeriesChart), in the bucket holding it.
  // Reported in the data's own buckets, not Rate's wide bars, which would
  // pull every chart in the group back to the bar's start.
  const newest = useGroupLatest(id, start + Math.max(0, Math.ceil((end - start) / data.bucketMs) - 1) * data.bucketMs)
  const tipBucket = hoverBucket ?? (tipBelow && newest !== null && newest >= start ? snap(newest) : null)
  const isSource = hoverBucket !== null && hover?.source === id
  const showTip = tipBucket !== null && (tipBelow || isSource || (pinned && hoverBucket !== null))
  const hx = hoverBucket === null ? 0 : x(hoverBucket)
  // The grip sits mid-bar in Rate (the hover is a band there), on the line in Events.
  const gripX = hoverBucket === null ? 0 : view === "rate" ? (hx + x(Math.min(end, hoverBucket + bucket))) / 2 : hx

  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || tipBelow) return
    const w = tip.offsetWidth
    const at = hx + 12 + w <= width ? hx + 12 : hx - 12 - w
    tip.style.left = `${Math.max(0, Math.min(at, width - w))}px`
  })

  const laneH = LANE_H[view]
  const xTicks = timeTicks(start, end, Math.max(2, Math.floor(plotW / 60)))

  return (
    <div
      ref={wrapRef}
      className="clc"
      data-chart=""
      role="group"
      aria-label={`${label}, ${view === "rate" ? "rate per drive" : "changes per drive"}`}
      tabIndex={0}
      onPointerMove={e => { tap.move(e); onPointer(e) }}
      onPointerDown={onPress}
      onPointerUp={tap.up}
      onPointerCancel={tap.cancel}
      onPointerLeave={e => { if (e.pointerType !== "touch" && !pinned) hoverAt(null) }}
      onFocus={() => { if (!hover) hoverAt(lastBucket) }}
      // Only the chart that set the reading clears it, and focus moving
      // within the chart keeps it, as does pinning (see TimeSeriesChart).
      onBlur={e => {
        if (hover?.source !== id || hover.touch || pinned) return
        if (!(e.relatedTarget instanceof Node && wrapRef.current?.contains(e.relatedTarget))) hoverAt(null)
      }}
      onKeyDown={onKeyDown}
    >
      {lanes.map((l, i) => {
        const color = l.drive.style.color
        const first = firstRecord(l.points)!
        const dim = highlight && l.drive.guid !== highlight ? " dim" : ""
        return (
          <div key={l.drive.guid} className="clc-lane">
            <div className="clc-head">
              {chips && <ChartDriveChip drive={l.drive} />}
              {l.status && <span className="clc-status"><LaneStatusText lane={l.status} windowLabel={windows.label} end={end} format={format} /></span>}
            </div>
            <div className="clc-strip-wrap">
              {gripped && hoverBucket !== null && <LineGrip x={gripX} top={0} height={laneH} onDrag={cx => hoverAt(snap(clientT(cx)), { touch: true })} />}
              <svg className={`clc-strip${dim}`} width={width} height={laneH} viewBox={`0 0 ${width} ${laneH}`} aria-hidden="true">
                <defs>
                  <pattern id={`${uid}-h${i}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line className="clc-hatch" x1="0" y1="0" x2="0" y2="6" />
                  </pattern>
                </defs>
                {first > start && <rect x={ML} y={0} width={Math.max(0, x(first) - ML)} height={laneH} fill={`url(#${uid}-h${i})`} />}
                {jobs.map((b, j) => <rect key={j} className="tsc-span" x={b.x} y={0} width={b.w} height={laneH} />)}
                <rect className="clc-recent" x={recentX} y={0} width={Math.max(0, ML + plotW - recentX)} height={laneH} />
                {view === "events"
                  ? <EventMarks lane={l} x={x} start={start} end={end} plotEnd={ML + plotW} h={laneH} color={color} format={format} />
                  : <RateBars lane={l} x={x} windows={windows} plotEnd={ML + plotW} h={laneH} yMax={yMax} color={color} />}
                {showTotal && <TotalBackdrop points={l.points} x={x} start={start} plotEnd={ML + plotW} h={laneH} log={log} />}
                {hoverBucket !== null && (view === "rate"
                  ? <rect className={`clc-hover-band${pinned ? " pinned" : ""}`} x={hx} y={0} width={Math.max(1, x(Math.min(end, hoverBucket + bucket)) - hx)} height={laneH} />
                  : <line className={`tsc-crosshair${gripped || pinned ? " grip" : ""}`} x1={hx} x2={hx} y1={0} y2={laneH} />)}
              </svg>
            </div>
          </div>
        )
      })}

      <div className="clc-axis-wrap">
        <AxisScrub top={0} height={AXIS_H} onTime={cx => hoverAt(snap(clientT(cx)), { touch: true })} />
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
      </div>

      {showTip && (
        <div ref={tipRef} className={`tsc-tip${tipBelow ? " below" : pinned ? " pinned" : ""}`} role={isSource ? "status" : undefined}>
          <div className="tsc-tip-time">{bucketLabel(tipBucket, bucket)}</div>
          <TipRows lanes={lanes} view={view} t={tipBucket} bucket={bucket} end={end} format={format} keepEmpty={tipBelow} />
        </div>
      )}
    </div>
  )
}

export default memo(CounterLanesChart)

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
      const moved = [s.up && `+${format.value(s.up)}`, s.down && `−${format.value(s.down)}`].filter(Boolean).join(" ")
      return <>{value} · <span className="clc-warn">{moved} in last {windowLabel}</span></>
    }
    if (s.kind === "last") {
      return <>{value} · <span className="clc-muted">last {s.delta > 0 ? "+" : "−"}{format.value(Math.abs(s.delta))} · {ageLabel(end - s.t)} ago</span></>
    }
    const what = s.value === 0 ? "0 throughout" : s.since !== null ? `unchanged since ${new Date(s.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "unchanged in range"
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
  for (const c of counterChanges(lane.points)) {
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
  const pts = points.filter((p): p is { t: number; v: number } => p.v !== null)
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
function TipRows({ lanes, view, t, bucket, end, format, keepEmpty }: {
  lanes: Lane[]; view: "events" | "rate"; t: number; bucket: number; end: number; format: CounterFormat; keepEmpty: boolean
}) {
  const rows = lanes.flatMap((l): { drive: ChartDrive; text: string | null }[] => {
    const empty = keepEmpty ? [{ drive: l.drive, text: null }] : []
    const signed = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${format.value(Math.abs(d))}`
    if (view === "rate") {
      const b = l.buckets.find(q => q.start === t)
      return b && b.delta !== null ? [{ drive: l.drive, text: signed(b.delta) }] : empty
    }
    // The count as the bucket closes, and what changed within it.
    const e = Math.min(end, t + bucket)
    const to = stepValue(l.points, e >= end ? end : e - 1)
    if (to === null) return empty
    const delta = netChange(counterChanges(l.points), t, e, end)
    const text = `${format.value(to)}${delta ? ` (${signed(delta)})` : ""}`
    return [{ drive: l.drive, text }]
  })
  if (!rows.length) return <div className="tsc-tip-none">No data</div>
  return (
    <div className="tsc-tip-rows">
      {rows.map(r => (
        <div key={r.drive.guid} className="tsc-tip-row">
          <span className="tsc-tip-label"><ChartDriveChip drive={r.drive} /></span>
          <span className="tsc-tip-value">{r.text ?? <span className="tsc-tip-empty">—</span>}</span>
        </div>
      ))}
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
