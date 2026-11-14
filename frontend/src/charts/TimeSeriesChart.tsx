import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent, ReactNode } from "react"
import { useChartHover, useLeftGutter } from "./chartHover"
import { formatTick, log1pTicks, momentLabel, niceTicks, timeTicks, yScale } from "./scales"
import type { YScale } from "./scales"
import { seriesPaths, valueAt, nearest } from "./chartGeometry"
import type { ChartSeries } from "./chartGeometry"
import LineKey from "./LineKey"
import "./TimeSeriesChart.css"

export type { ChartPoint, ChartSeries } from "./chartGeometry"

// A plain SVG time-series chart that every history view is built on: lines or
// step lines per series, optional area wash, threshold lines, status bands,
// shaded spans (jobs), and a crosshair + tooltip that reads every series at
// the hovered time. It knows nothing about drives; the charts built on it
// decide what the series are.

export type Tone = "ok" | "warn" | "crit"

export interface ChartThreshold { value: number; label: string; tone: Exclude<Tone, "ok"> }
export interface ChartBand { from: number; to: number; tone: Tone; label?: string }
/** A shaded stretch of time, e.g. a job; end null runs to the chart's end.
 *  Spans are deliberately colorless: with several drives charted, a drive's
 *  color on overlapping spans just shows whichever was drawn last. Which job
 *  (and drive) it was is the tooltip's job, via tooltipExtra. */
export interface ChartSpan { id: string; start: number; end: number | null; label?: string }

interface Props {
  series: ChartSeries[]
  /** The x domain, ms. */
  start: number
  end: number
  ariaLabel: string
  height?: number
  yScale?: YScale
  /** Fixed ends of the y domain; otherwise it fits the data (rounded out to ticks). */
  yMin?: number
  yMax?: number
  /** Values the y domain must reach, e.g. a threshold worth seeing before it's crossed. */
  yInclude?: number[]
  yTicks?: number[]
  formatY?: (v: number) => string
  /** A value as the tooltip shows it; t is the hovered time, for looking up
   *  related values (e.g. the bucket's maximum beside its average). */
  formatValue?: (v: number, series: ChartSeries, t: number) => string
  thresholds?: ChartThreshold[]
  bands?: ChartBand[]
  spans?: ChartSpan[]
  /** The crosshair snaps to start + k·snapMs (the bucket starts). Without it,
   *  it snaps to the nearest point of any series. */
  snapMs?: number
  /** Lines break across gaps between points longer than this; default 1.5 × snapMs. */
  gapMs?: number
  /** Extra tooltip lines for the hovered time, after the series rows. */
  tooltipExtra?: (t: number) => ReactNode
  formatTime?: (t: number) => string
  className?: string
}

// Margins around the plot area, in px: the bottom one holds the x tick
// labels; the right one just fits the end dots. The left one holds the y tick
// labels and is sized to them (yGutter). Everything is drawn in real pixels
// (the viewBox matches the measured width), so text and 2px lines never scale.
const M = { top: 10, right: 6, bottom: 22 }
// Gap between a y tick label and the plot.
const TICK_GAP = 6
// Spans (jobs) are also marked in a thin neutral rail just above the plot —
// not on its top edge, where a span covering the whole range would read as a
// line of data. Overlapping spans simply merge into one bar.
const RAIL = { gap: 3, height: 2 }
const FALLBACK_WIDTH = 600   // before the first measure (and in jsdom, which has no layout)
// Below this chart width the tooltip would cover most of the plot (and run
// off a phone screen), so the readings show under the chart instead.
const TIP_BELOW_WIDTH = 520

export default function TimeSeriesChart(props: Props) {
  const {
    series, start, end, ariaLabel, height = 180, snapMs,
    formatY = formatTick, formatValue = v => formatTick(v), formatTime = momentLabel,
  } = props
  // Identifies this chart as the hover source, so in a ChartHoverSync group
  // only the chart under the pointer shows its tooltip.
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const width = useWidth(wrapRef)
  const { hover, setHover } = useChartHover()

  // Recomputed each render: a few hundred points per series is cheap, and
  // hover re-renders only move the crosshair's inputs.
  const plotH = Math.max(20, height - M.top - M.bottom)
  const domain = yDomain(props, plotH)
  // Left margin: just wide enough for this chart's y tick labels — or, in a
  // ChartHoverSync group, for the widest of any chart's, so every chart's
  // plot starts at the same x and their crosshairs line up.
  const ML = useLeftGutter(id, TICK_GAP + Math.ceil(Math.max(0, ...domain.ticks.map(v => tickTextWidth(formatY(v))))))
  const plotW = Math.max(40, width - ML - M.right)
  // x: time (ms) → px, and toT, its inverse, for turning the pointer into a time.
  const x = (t: number) => ML + ((t - start) / (end - start || 1)) * plotW
  const toT = (px: number) => start + ((px - ML) / plotW) * (end - start)
  // y: value → px. SVG's y grows downwards, so the domain's low end maps to
  // the plot's bottom edge. Values outside a fixed yMin/yMax are clamped to
  // the edge rather than drawn outside the plot.
  const rawY = yScale(props.yScale ?? "linear", domain.lo, domain.hi, M.top + plotH, M.top)
  const y = (v: number) => Math.min(M.top + plotH, Math.max(M.top, rawY(v)))
  // Roughly one x tick per 60px of plot width.
  const layout = { ...domain, xTicks: timeTicks(start, end, Math.max(2, Math.floor(plotW / 60))) }

  // Tick labels closer than 11px to the last one drawn are skipped (on a short
  // log axis, 0 and 1 sit almost on top of each other); the gridline stays.
  const labelled = new Set<number>()
  let lastLabelY = Infinity
  for (const v of domain.ticks) {
    if (lastLabelY - y(v) >= 11) { labelled.add(v); lastLabelY = y(v) }
  }

  // Spans (jobs) clipped to the plot; ones wholly outside the range are
  // dropped, and a very short one still gets 2px so it stays visible.
  // Overlapping spans are merged first: the shade is translucent, so stacked
  // copies would add up to a bright streak wherever several jobs overlap.
  const spanBoxes = mergeSpans((props.spans ?? []).flatMap(sp => {
    const a = Math.max(ML, x(Math.max(sp.start, start)))
    const b = Math.min(ML + plotW, x(Math.min(sp.end ?? end, end)))
    return b < ML || a > ML + plotW ? [] : [{ id: sp.id, x: a, w: Math.max(2, b - a) }]
  }))

  // A missing bucket between two points means no readings (drive absent,
  // collector stopped), so the line breaks there instead of bridging it. Half
  // a bucket of slack keeps neighbouring buckets joined.
  const gapMs = props.gapMs ?? (snapMs ? snapMs * 1.5 : Infinity)
  const paths = series.map(s => ({ s, ...seriesPaths(s, x, y, end, gapMs, domain.lo) }))

  // ── hover ───────────────────────────────────────────────────────────────
  // The hovered time lives in the hover state (shared or local); everything
  // drawn for it — crosshair, dots, tooltip — is derived from it below.

  // Every time any series has a point at, sorted: the crosshair's stops when
  // there's no bucket grid to snap to.
  const allTimes = useMemo(
    () => [...new Set(series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b),
    [series])
  // Past the newest line point there is nothing to read (the newest buckets
  // are still being rolled up), so the crosshair stops there. Step series
  // hold their value to the end, so they don't limit it.
  const lineEnd = Math.max(-Infinity, ...series.filter(s => s.shape !== "step").flatMap(s => {
    const last = s.points.findLast(p => p.v !== null)
    return last ? [last.t] : []
  }))
  // A raw time (from the pointer or a key) → the data position to show:
  // the nearest bucket start, kept between the range start and the newest
  // reading, or else the nearest point time.
  const snap = (t: number): number | null => {
    if (snapMs) {
      const lastBucket = start + Math.floor((end - start) / snapMs) * snapMs
      const last = lineEnd > start ? Math.min(lineEnd, lastBucket) : lastBucket
      return Math.min(last, Math.max(start, start + Math.round((t - start) / snapMs) * snapMs))
    }
    return nearest(allTimes, t)
  }
  // One position left or right of t, for the arrow keys.
  const step = (t: number, dir: 1 | -1): number | null => {
    if (snapMs) return snap(t + dir * snapMs)
    const i = allTimes.indexOf(t) + dir
    return allTimes[Math.min(allTimes.length - 1, Math.max(0, i))] ?? null
  }
  // Keyboard focus starts on the newest point: the bucket at `end` is still
  // filling, so it rarely has any data yet.
  const latest = () => allTimes.length ? allTimes[allTimes.length - 1] : snap(end)
  const hoverAt = (t: number | null) => setHover(t === null ? null : { t, source: id })
  // Pointer x → time. The rendered width can briefly differ from the measured
  // one (mid-resize), so scale client px to the SVG's own px first.
  const pointerT = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return toT(((e.clientX - r.left) / (r.width || width)) * width)
  }
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "Escape") return hoverAt(null)
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    const from = hover?.t ?? latest()
    if (from !== null) hoverAt(step(from, e.key === "ArrowRight" ? 1 : -1))
  }

  // A synced chart may be handed a time outside this chart's range; ignore it.
  const hoverT = hover && hover.t >= start && hover.t <= end ? hover.t : null
  // Each series' value at the hovered time; series with nothing there (a
  // missing bucket, or before a step series starts) are left out.
  const readings = hoverT === null ? [] : series
    .map(s => ({ s, v: valueAt(s, hoverT, snapMs) }))
    .filter((r): r is { s: ChartSeries; v: number } => r.v !== null)
  // Every chart in a sync group draws the crosshair; only the hovered one
  // draws the tooltip.
  const showTip = hoverT !== null && hover?.source === id
  const hx = hoverT === null ? 0 : x(hoverT)
  const tipBelow = width < TIP_BELOW_WIDTH

  // A floating tooltip sits right of the crosshair, or left of it where it
  // would run past the chart's right edge, and is kept inside the chart
  // either way. Placed after layout, since that needs the tooltip's width;
  // still before paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || tipBelow) return
    const w = tip.offsetWidth
    const at = hx + 12 + w <= width ? hx + 12 : hx - 12 - w
    tip.style.left = `${Math.max(0, Math.min(at, width - w))}px`
  })

  return (
    <div ref={wrapRef} className={`tsc${props.className ? ` ${props.className}` : ""}`}>
      {/* Layers are painted in order, back to front: bands, job shading,
          grid and axes, job rail, thresholds, areas, lines, end dots, then
          the hover crosshair on top. */}
      <svg
        className="tsc-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={e => hoverAt(snap(pointerT(e)))}
        onPointerDown={e => hoverAt(snap(pointerT(e)))}   // a tap on touch screens
        // A lifted finger "leaves" too, which would clear a tap's reading as
        // soon as it showed; on touch it stays until focus moves (a tap elsewhere).
        onPointerLeave={e => { if (e.pointerType !== "touch") hoverAt(null) }}
        onFocus={() => { if (!hover) hoverAt(latest()) }}   // keyboard users get a reading straight away
        onBlur={() => hoverAt(null)}
        onKeyDown={onKeyDown}
      >
        {props.bands?.map((b, i) => {
          const top = y(Math.max(b.from, b.to)), bottom = y(Math.min(b.from, b.to))
          return (
            <g key={`band-${i}`}>
              <rect className={`tsc-band tone-${b.tone}`} x={ML} y={top} width={plotW} height={Math.max(0, bottom - top)} />
              {b.label && plotW > 360 && bottom - top >= 14 && (
                <text className="tsc-band-label" x={ML + 4} y={top + 11}>{b.label}</text>
              )}
            </g>
          )
        })}

        {spanBoxes.map(sp => (
          <rect key={`span-${sp.id}`} className="tsc-span" x={sp.x} y={M.top} width={sp.w} height={plotH} />
        ))}

        {layout.ticks.map((v, i) => (
          <g key={`y-${v}`}>
            <line className={i === 0 ? "tsc-baseline" : "tsc-grid"} x1={ML} x2={ML + plotW} y1={y(v)} y2={y(v)} />
            {labelled.has(v) && <text className="tsc-tick" x={ML - TICK_GAP} y={y(v) + 3.5} textAnchor="end">{formatY(v)}</text>}
          </g>
        ))}

        {layout.xTicks.map(tk => {
          const tx = x(tk.t)
          // Skip ticks so close to an edge that their label would hang off it.
          if (tx < ML + 14 || tx > ML + plotW - 14) return null
          return (
            <g key={`x-${tk.t}`}>
              <line className="tsc-baseline" x1={tx} x2={tx} y1={M.top + plotH} y2={M.top + plotH + 4} />
              <text className="tsc-tick" x={tx} y={height - 6} textAnchor="middle">{tk.label}</text>
            </g>
          )
        })}

        {spanBoxes.map(sp => (
          <rect key={`edge-${sp.id}`} className="tsc-span-edge" x={sp.x} y={M.top - RAIL.gap - RAIL.height}
            width={sp.w} height={RAIL.height} rx={1} />
        ))}

        {props.thresholds?.map(th => {
          const ty = y(th.value)
          // Off the y domain: pass the value in yInclude to keep it in view.
          if (th.value < layout.lo || th.value > layout.hi) return null
          return (
            <g key={`th-${th.value}`} className={`tsc-threshold tone-${th.tone}`}>
              <line x1={ML} x2={ML + plotW} y1={ty} y2={ty} />
              <text x={ML + 4} y={ty - 4}>{th.label}</text>
            </g>
          )
        })}

        {paths.map(({ s, area }) => area && (
          <path key={`area-${s.id}`} className="tsc-area" d={area} fill={s.color} />
        ))}
        {paths.map(({ s, line }) => (
          <path key={`line-${s.id}`} className="tsc-line" d={line} stroke={s.color} strokeDasharray={s.dash} />
        ))}
        {paths.map(({ s, last }) => last && (
          <circle key={`end-${s.id}`} className="tsc-dot" cx={last.x} cy={last.y} r={4} fill={s.color} />
        ))}

        {hoverT !== null && (
          <g className="tsc-hover">
            <line className="tsc-crosshair" x1={hx} x2={hx} y1={M.top} y2={M.top + plotH} />
            {readings.map(r => (
              <circle key={r.s.id} className="tsc-dot" cx={hx} cy={y(r.v)} r={4} fill={r.s.color} />
            ))}
          </g>
        )}
      </svg>

      {/* HTML, not SVG, so text wraps and sizes naturally. Floats beside the
          crosshair (placed above), or on a narrow chart sits under it in the
          page flow, full width. Rows are label then value, on one grid so
          the values line up in a column. */}
      {showTip && (
        <div ref={tipRef} className={`tsc-tip${tipBelow ? " below" : ""}`} role="status">
          <div className="tsc-tip-time">{formatTime(hoverT)}</div>
          {readings.length === 0 && <div className="tsc-tip-none">No data</div>}
          {readings.length > 0 && (
            <div className="tsc-tip-rows">
              {/* Highest first, so rows line up with the lines' vertical order. */}
              {[...readings].sort((a, b) => b.v - a.v).map(r => (
                <div key={r.s.id} className="tsc-tip-row">
                  <span className="tsc-tip-label">
                    {r.s.tipLabel ?? <>
                      <LineKey color={r.s.color} dash={r.s.dash} width={12} />
                      <span className="tsc-tip-name">{r.s.label}</span>
                    </>}
                  </span>
                  <span className="tsc-tip-value">{formatValue(r.v, r.s, hoverT)}</span>
                </div>
              ))}
            </div>
          )}
          {props.tooltipExtra && <TipExtra>{props.tooltipExtra(hoverT)}</TipExtra>}
        </div>
      )}
    </div>
  )
}

function TipExtra({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === false) return null
  return <div className="tsc-tip-extra">{children}</div>
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** A y tick label's width in px at the .tsc-tick size (10.5px, tabular
 *  digits), estimated per character — near enough for sizing the gutter, and
 *  the same in tests (jsdom has no text layout) as in the browser. */
function tickTextWidth(text: string): number {
  let w = 0
  for (const ch of text) w += /[0-9]/.test(ch) ? 6.2 : /[.,: ]/.test(ch) ? 3 : ch === "°" ? 4.5 : 7.5
  return w
}

/** The y axis: its ticks and the [lo, hi] it spans. A log1p axis always runs
 *  from 0 to the decade at or above the largest value. A linear one fits the
 *  data plus yInclude, rounded out to clean ticks (about one per 36px), unless
 *  yMin / yMax pin an end — then ticks beyond that end are dropped. */
function yDomain(props: Props, plotH: number): { ticks: number[]; lo: number; hi: number } {
  const values = props.series.flatMap(s => s.points.map(p => p.v)).filter((v): v is number => v !== null)
  const forced = [...(props.yInclude ?? [])]
  const all = [...values, ...forced]
  if (props.yScale === "log1p") {
    const ticks = props.yTicks ?? log1pTicks(Math.max(0, ...all))
    return { ticks, lo: 0, hi: ticks[ticks.length - 1] }
  }
  const lo = props.yMin ?? (all.length ? Math.min(...all) : 0)
  const hi = props.yMax ?? (all.length ? Math.max(...all) : 1)
  const ticks = props.yTicks ?? niceTicks(lo, hi, Math.max(2, Math.floor(plotH / 36)))
  const dLo = props.yMin ?? ticks[0]
  const dHi = props.yMax ?? ticks[ticks.length - 1]
  return { ticks: ticks.filter(t => t >= dLo - 1e-9 && t <= dHi + 1e-9), lo: dLo, hi: dHi }
}

/** Boxes sorted and merged where they overlap or touch, keeping the first id. */
function mergeSpans(boxes: { id: string; x: number; w: number }[]) {
  const merged: { id: string; x: number; w: number }[] = []
  for (const b of [...boxes].sort((p, q) => p.x - q.x)) {
    const last = merged[merged.length - 1]
    if (last && b.x <= last.x + last.w) last.w = Math.max(last.w, b.x + b.w - last.x)
    else merged.push({ ...b })
  }
  return merged
}

/** The element's width in px, kept up to date as it resizes. The chart draws
 *  at this width rather than scaling a fixed viewBox, so it stays crisp in a
 *  wide workspace panel and a narrow card popover alike. */
function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => { if (el.clientWidth > 0) setWidth(el.clientWidth) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
