import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { IconArrowDown, IconArrowUp, IconClock, IconLoader2, IconServer, IconTemperature } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { SIGNALS, DEFAULT_FOOTER_SIGNALS } from "./signals"
import SignalValue from "./SignalValue"
import { formatCapacity, formatDuration, formatRelativeTime, formatThroughput, jobResultText } from "./format"
import AsOf from "./AsOf"
import SelfTestLights, { SelfTestPopover } from "./SelfTestLights"
import { useSmartRead } from "./smartReadContext"
import { isStale, useNow } from "./useNow"
import { JobDetailRows } from "./JobDetails"
import { TaskRow } from "./BatchRow"
import { batchOutcome, batchState, batchSteps, groupTasks, itemDuration, itemFinishedAt, type TaskItem } from "./taskItems"
import { STATUS_ICON } from "./jobStatusIcon"
import CancelJobButton from "./CancelJobButton"
import { useJobs } from "./jobsContext"
import DriveOverview from "./DriveOverview"
import { useEdgeFade } from "./useEdgeFade"
import { useHoverPopover } from "./useHoverPopover"
import { useJobTiming } from "./useJobTiming"
import { useLongPress } from "./useLongPress"
import Serial from "./Serial"
import DriveTrendPopover from "./DriveTrendPopover"
import { hasTrend } from "./charts/counters"
import type { TrendMetric } from "./DriveTrendPopover"
import { seriesStyle } from "./charts/drivePalette"
import type { SeriesStyle } from "./charts/drivePalette"
import "./DriveCard.css"

interface Props {
  drive: Drive
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
  onSelectToggle: () => void
  onContextMenu?: (guid: string, pos: { x: number; y: number }) => void
  footerSignals?: Record<string, string[]>
  job?: Job
  queuedJobs: Job[]
  /** Finished jobs on this drive the user hasn't seen yet, newest first. */
  newResults?: Job[]
  /** The drive's last finished task: one job, or every step of its batch. */
  lastTask?: Job[]
  /** A drive menu is open: no hover popovers, so none can open over it. */
  menuOpen?: boolean
  /** This drive's line color in history charts (its Health > Trends color),
   *  for the trend popovers on its values. */
  trendStyle?: SeriesStyle
}

// How long the pointer has to sit still over a trigger before the hover
// preview commits — tune this to taste. Intentionally not instant: a short
// "hover intent" delay is what stops the bubble flashing open on every
// incidental mouse pass-through on the way to somewhere else on the card.
const HOVER_DELAY_MS = 400

export default function DriveCard({ drive, selected, onSelect, onSelectToggle, onContextMenu, footerSignals, job, queuedJobs, newResults = [], lastTask = [], menuOpen = false, trendStyle = DEFAULT_TREND_STYLE }: Props) {
  const health  = (drive.health_status && HEALTH_DISPLAY[drive.health_status]) || HEALTH_DISPLAY.Unrated
  const tempHot = drive.signal_flags?.temp === "warn"
  const sigMap  = footerSignals ?? DEFAULT_FOOTER_SIGNALS
  const sigKeys = sigMap[drive.drive_type ?? "default"] ?? sigMap["default"]
  const liveTemp = drive.vitals.temp ?? drive.temp
  const io = drive.vitals.io
  // Live values say nothing about their age while fresh; overdue ones turn
  // amber with it (the collector stalled, or the drive stopped answering).
  const now = useNow()
  const vitalsAt = drive.vitals.captured_at
  const vitalsStale = isStale(vitalsAt, drive.stale_after_s.vitals, now)

  const timing = useJobTiming(job)

  // Each scrollable row (mobile/touch only — see DriveCard.css) gets its own
  // overflow check, so the edge-fade only shows up on a row that's actually
  // scrollable. dc-tn-id is shared by the running/queued task-zone branches
  // below since only one of them ever mounts at a time.
  const [idFadeRef, idFaded] = useEdgeFade<HTMLDivElement>()
  const [traitsFadeRef, traitsFaded] = useEdgeFade<HTMLDivElement>()
  const [stateFadeRef, stateFaded] = useEdgeFade<HTMLDivElement>()
  const [tnIdFadeRef, tnIdFaded] = useEdgeFade<HTMLDivElement>()
  const [tzMsgFadeRef, tzMsgFaded] = useEdgeFade<HTMLSpanElement>()
  const [fsFadeRef, fsFaded] = useEdgeFade<HTMLDivElement>()

  // (hover: hover) is true for a device whose *primary* pointer can actually
  // hover (a mouse) — false for touch, even on a touchscreen laptop with a
  // mouse attached, if touch is what's currently driving. Read once at
  // mount; doesn't need to react to input switching mid-session for this.
  const [supportsHover] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches)

  // "task" shows the active job's full details, "queued" lists every queued
  // job for this drive, "complete" its unseen results and "health" its health
  // overview. Rendered through a portal: .drive-card needs overflow:hidden
  // (its rounded left corners only render right when the accent bar is
  // clipped to the card's radius), which would clip an inline popover
  // whenever there isn't much card below the task zone.
  const pop = useHoverPopover<PopoverKey>({ supportsHover, delayMs: HOVER_DELAY_MS, disabled: menuOpen })
  const { jobs: allJobs, cancelJob, cancelBatch } = useJobs()
  // A full read asked for by hand is under way: the self-test popover says so.
  const smartReading = useSmartRead().reading.has(drive.guid)

  // The menu opens at the pointer, where this card's popover would open
  // too, on top of it: close that (and any pending one) first.
  const openMenu = (pos: { x: number; y: number }) => {
    pop.close()
    onContextMenu?.(drive.guid, pos)
  }

  // Touch has no right-click: press and hold opens the same menu.
  const longPress = useLongPress(openMenu, !supportsHover)

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    openMenu({ x: e.clientX, y: e.clientY })
  }

  // The batch the active job is a step of, with every step known (live list,
  // unseen results, its queue, the job itself; later entries win).
  const batch = job?.batch ?? null
  const batchJobs = batch && job ? batchSteps([...newResults, ...allJobs, ...queuedJobs, job]).get(batch.id) ?? [job] : []
  const batchTotal = batch ? batchState(batchJobs).total : 0
  // Queued behind the batch: its own later steps are counted by its pill.
  const otherQueued = batch ? queuedJobs.filter(j => j.batch?.id !== batch.id) : queuedJobs

  // What an idle card shows: the last task, as Activity and History name it.
  const lastItem = lastTask.length > 0 ? groupTasks(lastTask)[0] : null

  // A batch's steps show together, as one row (with steps from the live list).
  const jobRows = (jobs: Job[]) => groupTasks(jobs, allJobs).map(item =>
    <TaskRow key={item.key} item={item} drive={drive} onCancel={cancelJob} onCancelBatch={cancelBatch} compact />)
  const popoverBody = {
    // Named here because the details rows don't say which job it is.
    task: job && (
      <>
        <div className="dc-pop-head">
          <span className="dc-pop-title">{job.operation_name}</span>
          <CancelJobButton job={job} drive={drive} onCancel={id => { cancelJob(id); pop.close() }} />
        </div>
        <JobDetailRows job={job} />
      </>
    ),
    queued: otherQueued.length > 0 && jobRows(otherQueued),
    last: lastItem && <TaskRow item={lastItem} drive={drive} onCancel={cancelJob} onCancelBatch={cancelBatch} compact />,
    batch: batch && <TaskRow item={{ kind: "batch", key: `batch-${batch.id}`, batchId: batch.id, steps: batchJobs }} drive={drive} onCancel={cancelJob} onCancelBatch={cancelBatch} compact />,
    complete: newResults.length > 0 && jobRows(newResults),
    // The overview, then the score's history.
    health: <>
      <DriveOverview drive={drive} header={false} />
      <div className="dc-pop-trend"><DriveTrendPopover drive={drive} style={trendStyle} metric="health" /></div>
    </>,
    tests: <SelfTestPopover drive={drive} reading={smartReading} />,
  }[pop.open && !isTrendKey(pop.open) ? pop.open : "task"]
  const trendMetric = pop.open && isTrendKey(pop.open) ? pop.open.slice(TREND.length) as TrendMetric : null
  const popoverClass = trendMetric || pop.open === "health" ? " dc-popover-chart" : pop.open === "task" ? "" : " dc-popover-wide"
  // A value with a chart opens its history: the same chart as Health >
  // Trends, for this drive (DriveTrendPopover).
  const trendTrigger = (metric: TrendMetric) => pop.trigger(`${TREND}${metric}`)
  const popoverContent = pop.open && (trendMetric || popoverBody) && createPortal(
    <div className={`dc-popover${popoverClass}`} style={pop.pos} {...pop.popoverProps}>
      {trendMetric && <DriveTrendPopover drive={drive} style={trendStyle} metric={trendMetric} />}
      {!trendMetric && popoverBody}
    </div>,
    document.body,
  )

  // Yellow text, never an outcome color: green/red on a drive card always
  // means health. How each job ended is in its popover (status icon) and on
  // the Activity tab.
  const completePill = newResults.length > 0 && (
    <button className="dc-complete-pill" {...pop.trigger("complete")} aria-label={`${newResults.length} complete`}>
      <CountLabel n={newResults.length} full={`${newResults.length} complete`} />
    </button>
  )
  // The task's name row: its name in a pill, then the batch's pill (opens the
  // batch's row), what's queued behind it, unseen results and ×. When the
  // names don't fit, the count pills shrink to their numbers first.
  const tnRef = useRef<HTMLDivElement>(null)
  useShortPillsToFit(tnRef, [job?.id, job?.status, otherQueued.length, newResults.length, batchTotal])
  const nameRow = job && (
    <div className="dc-tn" ref={tnRef}>
      <div ref={tnIdFadeRef} className={`dc-tn-id${tnIdFaded ? " dc-edge-fade" : ""}`}>
        {job.status === "running" ? <IconLoader2 size={11} className="spinning" /> : <IconClock size={11} />}
        <span className="dc-tn-op" title={job.status === "queued" ? `Queued: ${job.operation_name}` : job.operation_name}>{job.operation_name}</span>
      </div>
      <div className="dc-tn-right">
        {batch && (
          <button className="dc-batch-pill" {...pop.trigger("batch")} aria-label={`${batch.recipe_name ?? "Batch"}, step ${batch.step + 1} of ${batchTotal}`}>
            <span className="dc-batch-pill-name">{batch.recipe_name ?? "Batch"}</span>
            <span className="dc-batch-pill-n">{batch.step + 1}/{batchTotal}</span>
          </button>
        )}
        {otherQueued.length > 0 && (
          <button className="dc-queued-pill" {...pop.trigger("queued")} aria-label={`${batch ? "+" : ""}${otherQueued.length} queued`}>
            <CountLabel n={otherQueued.length} prefix={batch ? "+" : ""} full={`${batch ? "+" : ""}${otherQueued.length} queued`} />
          </button>
        )}
        {completePill}
        <CancelJobButton job={job} drive={drive} onCancel={cancelJob} />
      </div>
    </div>
  )

  return (
    <div
      className={`drive-card bar-${health.bar}${selected ? " sel" : ""}${drive.locked ? " locked" : ""}`}
      title={drive.locked ? "Write protected — destructive operations blocked" : undefined}
      onClick={(e) => {
        if (longPress.consumeLongPress()) return
        if (supportsHover) onSelect(e)
        else onSelectToggle()
      }}
      {...longPress.handlers}
      onContextMenu={supportsHover ? handleContextMenu : (e) => e.preventDefault()}
    >
      {/* Row 1: name + badge */}
      <div className="dc-r1">
        <div className="dc-sel-btn" />
        <div ref={idFadeRef} className={`dc-r1-id${idFaded ? " dc-edge-fade" : ""}`}>
          {(drive.white_label ?? drive.manufacturer_short) && <span className="dc-mfr">{drive.white_label ?? drive.manufacturer_short}</span>}
          <span className="dc-model">{drive.model ?? drive.device}</span>
          {drive.capacity_bytes && <span className="dc-model dc-cap">{formatCapacity(drive.capacity_bytes)}</span>}
          {drive.label && <span className="dc-label">({drive.label})</span>}
        </div>
        <span className={`dc-badge dc-badge-${health.bar}`} {...pop.trigger("health")}>
          <span>{health.label}</span>
          {drive.health_pct !== null && <span className="dc-badge-score">{drive.health_pct}</span>}
        </span>
      </div>

      {/* Row 2: traits (left) + serial (right) */}
      <div className="dc-traits">
        <div ref={traitsFadeRef} className={`dc-traits-left${traitsFaded ? " dc-edge-fade" : ""}`}>
          {drive.drive_type && <span className="dc-tv">{drive.drive_type}</span>}
          {drive.capacity_bytes != null && (
            <><span className="dc-tsep">·</span><span className="dc-tv">{formatCapacity(drive.capacity_bytes)}</span></>
          )}
          {drive.rpm && (
            <><span className="dc-tsep">·</span><span className="dc-tv">{(drive.rpm / 1000).toFixed(1)}k RPM</span></>
          )}
          {drive.bus && (
            <><span className="dc-tsep">·</span><span className="dc-tv">{drive.bus}</span></>
          )}
        </div>
        {drive.serial && <Serial value={drive.serial} className="dc-serial" />}
      </div>

      {/* Decorative leader line — 2/3 width */}
      <div className="dc-ldr"><div className="dc-ldr-line" /></div>

      {/* Row 3: active state — path + temp + mount status */}
      <div ref={stateFadeRef} className={`dc-state${stateFaded ? " dc-edge-fade" : ""}`}>
        <span className="dc-si"><IconServer size={11} /><span className="dc-sv">{drive.device}</span></span>
        {liveTemp !== null && (
          <>
            <span className="dc-tsep">·</span>
            <span {...trendTrigger("temp")} className="dc-si dc-trend" title={drive.vitals.temp_source ? `Source: ${drive.vitals.temp_source}` : undefined}>
              <IconTemperature size={11} />
              <span className={`dc-sv${tempHot ? " hot" : ""}`}>{liveTemp}°C</span>
            </span>
          </>
        )}
        <span className="dc-tsep">·</span>
        <span className={`dc-mount${drive.is_mounted ? " on" : ""}`}>
          <span className="dc-mount-dot" />
          {drive.is_mounted ? "mounted" : "unmounted"}
        </span>
        {vitalsStale && vitalsAt && (
          <><span className="dc-tsep">·</span><AsOf className="dc-sv" at={vitalsAt} staleAfterS={drive.stale_after_s.vitals} /></>
        )}
      </div>

      {/* Task zone */}
      {job?.status === "running" ? (
        <div
          className="dc-tz running"
          {...pop.trigger("task")}
        >
          {nameRow}
          {/* The percent sits at the end of the bar it describes, leaving the
              name row room for the name, the pills and the ×. */}
          <div className="dc-tz-bar-row">
            {batch
              ? (
                // One segment per step: those before this one in their
                // outcome's color, this one filling, the rest empty.
                <div className="dc-tz-segs">
                  {Array.from({ length: batchTotal }, (_, i) => {
                    const before = batchJobs.find(j => j.batch?.step === i)
                    return i === batch.step
                      ? <div key={i} className="dc-tz-bar"><TzBarFill percent={job.progress.percent} /></div>
                      : <div key={i} className={`dc-tz-bar dc-tz-seg${i < batch.step && before ? ` ${before.status}` : ""}`} />
                  })}
                </div>
              )
              : <div className="dc-tz-bar"><TzBarFill percent={job.progress.percent} /></div>}
            {job.progress.percent !== null && <span className="dc-tz-pct">{job.progress.percent.toFixed(1)}%</span>}
          </div>
          {(job.progress.message || timing.text) && (
            <div className="dc-tz-msg">
              {job.progress.message && (
                <span ref={tzMsgFadeRef} className={`dc-tz-msg-text${tzMsgFaded ? " dc-edge-fade" : ""}`}>
                  {job.progress.message}
                </span>
              )}
              {timing.text && <span className="dc-tz-time">{timing.text}</span>}
            </div>
          )}
        </div>
      ) : job?.status === "queued" ? (
        <div
          className="dc-tz queued"
          {...pop.trigger("task")}
        >
          {nameRow}
        </div>
      ) : (
        <div className="dc-tz idle">
          <div className="dc-tn">
            <IconClock size={11} />
            <span>Idle</span>
            {/* Names the lines below: what ran last, not what's running. */}
            {lastItem && <span className="dc-tn-sub">· Last task</span>}
            {completePill && <div className="dc-tn-right">{completePill}</div>}
          </div>
          {lastItem
            ? <LastTask item={lastItem} trigger={pop.trigger("last")} />
            : <div className="dc-tz-msg"><span>No tasks run yet</span></div>}
        </div>
      )}
      {popoverContent}

      {/* Footer */}
      <div className="dc-ft">
        <div ref={fsFadeRef} className={`dc-fs${fsFaded ? " dc-edge-fade" : ""}`}>
          {sigKeys.map(key => {
            const desc = SIGNALS[key]
            if (!desc) return null
            return (
              <div key={key} className={`dc-stat${hasTrend(key) ? " dc-trend" : ""}`} {...(hasTrend(key) ? trendTrigger(key) : {})}>
                <div className="dc-stat-label">{desc.label}</div>
                <SignalValue
                  className="dc-stat-value"
                  signal={key}
                  value={drive[key as keyof Drive] as number | boolean | null}
                  flag={drive.signal_flags?.[key]}
                />
              </div>
            )
          })}
        </div>
        {/* Self-test lights. Pinned outside .dc-fs so a narrow card fades a
            stat, never these. The popover also dates the SMART read. */}
        <div className="dc-stat dc-tests" {...pop.trigger("tests")}>
          <div className="dc-stat-label">Self-tests</div>
          <div className="dc-stat-value"><SelfTestLights coverage={drive.self_test_coverage} /></div>
        </div>
        <div {...trendTrigger("io")} className={`dc-io dc-trend${vitalsStale ? " stale" : ""}`}>
          <div className="dc-io-row rd">{formatThroughput(io.read_bytes_per_sec)}<IconArrowUp size={9} /></div>
          <div className="dc-io-row wr">{formatThroughput(io.write_bytes_per_sec)}<IconArrowDown size={9} /></div>
        </div>
      </div>
    </div>
  )
}

// Trend popovers are keyed "trend:<metric>".
const TREND = "trend:"
type PopoverKey = "task" | "queued" | "batch" | "last" | "complete" | "health" | "tests" | `${typeof TREND}${TrendMetric}`
const isTrendKey = (key: PopoverKey): key is `${typeof TREND}${TrendMetric}` => key.startsWith(TREND)
// Without a color from the grid (e.g. in tests): the first series color.
const DEFAULT_TREND_STYLE = seriesStyle(0)

const HEALTH_DISPLAY: Record<string, { bar: "green" | "aging" | "warn" | "red" | "critical" | "grey"; label: string }> = {
  Healthy:  { bar: "green",    label: "Healthy"  },
  Aging:    { bar: "aging",    label: "Aging"    },
  Degraded: { bar: "warn",     label: "Degraded" },
  Failing:  { bar: "red",      label: "Failing"  },
  Critical: { bar: "critical", label: "Critical" },
  Unrated:  { bar: "grey",  label: "Unrated"  },
}

function TzBarFill({ percent }: { percent: number | null }) {
  return percent === null
    ? <div className="dc-tz-bar-fill indeterminate" />
    : <div className="dc-tz-bar-fill" style={{ width: `${percent}%` }} />
}

// A count pill's text: in full ("3 queued"), or just the number while the
// name row is short of room (useShortPillsToFit). Both are rendered and CSS
// shows one, so switching needs no re-render.
function CountLabel({ n, full, prefix = "" }: { n: number; full: string; prefix?: string }) {
  return <><span className="dc-pill-full">{full}</span><span className="dc-pill-short" aria-hidden="true">{prefix}{n}</span></>
}

// Puts the name row in its short form (count pills as bare numbers) when the
// full one would cut off a name: the task's pill, or the whole name side on
// touch, where it scrolls instead of truncating. Measured before paint, and
// again whenever the row is resized.
function useShortPillsToFit(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    const fit = () => {
      row.classList.remove("dc-tn-short")
      const clipped = [...row.querySelectorAll<HTMLElement>(".dc-tn-id, .dc-tn-op, .dc-batch-pill-name")]
        .some(el => el.scrollWidth > el.clientWidth + 1)
      row.classList.toggle("dc-tn-short", clipped)
    }
    fit()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(fit)
    observer.observe(row)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

// An idle card's last task, on the lines a running task uses: its status
// icon, pill and when it finished, then its outcome and how long it ran.
// Grey throughout: on a card, green and red mean the drive's health; the
// icon's shape still says how it ended. Hover opens its row.
function LastTask({ item, trigger }: { item: TaskItem; trigger: Record<string, unknown> }) {
  const status = item.kind === "job" ? item.job.status : batchState(item.steps).status
  let pill: React.ReactNode, outcome: string
  if (item.kind === "job") {
    pill = <span className="dc-tn-op">{item.job.operation_name}</span>
    outcome = jobResultText(item.job)
  } else {
    const state = batchState(item.steps)
    const b = item.steps[0].batch!
    pill = (
      <span className="dc-batch-pill">
        <span className="dc-batch-pill-name">{b.recipe_name ?? "Batch"}</span>
        <span className="dc-batch-pill-n">{state.completed}/{state.total}</span>
      </span>
    )
    outcome = batchOutcome(state, b.stop_on_failure)
  }
  const duration = itemDuration(item)
  return (
    <div className="dc-tz-last" {...trigger}>
      <div className="dc-tn">
        <div className="dc-tn-id">
          <span className="dc-last-icon">{STATUS_ICON[status]}</span>
          {pill}
        </div>
        <span className="dc-tz-time">{formatRelativeTime(new Date(itemFinishedAt(item)).toISOString())}</span>
      </div>
      <div className="dc-tz-msg">
        <span className="dc-tz-msg-text" title={outcome}>{outcome}</span>
        {duration >= 0 && <span className="dc-tz-time">ran {formatDuration(duration / 1000)}</span>}
      </div>
    </div>
  )
}
