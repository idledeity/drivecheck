import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { IconArrowDown, IconArrowUp, IconBarcode, IconClock, IconLoader2, IconPencil, IconServer, IconTemperature } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { SIGNALS, DEFAULT_FOOTER_SIGNALS } from "./signals"
import { formatCapacity, formatDuration, formatRelativeTime, formatThroughput } from "./format"
import { JobDetailRows } from "./JobDetails"
import { useEdgeFade } from "./useEdgeFade"
import "./DriveCard.css"

interface Props {
  drive: Drive
  selected: boolean
  onSelect: () => void
  footerSignals?: Record<string, string[]>
  onLabelChange?: (guid: string, label: string | null) => void
  job?: Job
  queuedJobs: Job[]
}

// How long the pointer has to sit still over a trigger before the hover
// preview commits — tune this to taste. Intentionally not instant: a short
// "hover intent" delay is what stops the bubble flashing open on every
// incidental mouse pass-through on the way to somewhere else on the card.
const HOVER_DELAY_MS = 400

export default function DriveCard({ drive, selected, onSelect, footerSignals, onLabelChange, job, queuedJobs }: Props) {
  const health  = drive.health_status ? HEALTH_DISPLAY[drive.health_status] : HEALTH_DISPLAY.Unrated
  const tempHot = drive.signal_flags?.temp === "warn"
  const sigMap  = footerSignals ?? DEFAULT_FOOTER_SIGNALS
  const sigKeys = sigMap[drive.drive_type ?? "default"] ?? sigMap["default"]
  const liveTemp = drive.vitals.temp ?? drive.temp
  const io = drive.vitals.io

  // Ticks once a second only while a job is actually running — elapsed/ETA
  // text below is derived from this plus job.started_at, not from polled
  // job data (which only changes every few seconds at best).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (job?.status !== "running") return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [job?.status])

  const elapsedSeconds = job?.status === "running" && job.started_at
    ? (now - new Date(job.started_at).getTime()) / 1000
    : null
  // The backend already fills this in (operation's own estimate, or a
  // percent/elapsed extrapolation) — see JobRegistry.get_progress().
  const remainingSeconds = job?.progress.eta_seconds ?? null

  const [editingLabel, setEditingLabel] = useState(false)
  const [labelInput, setLabelInput] = useState("")
  const cancelLabelEdit = useRef(false)

  // Each scrollable row (mobile/touch only — see DriveCard.css) gets its own
  // overflow check, so the edge-fade only shows up on a row that's actually
  // scrollable. dc-tn-id is shared by the running/queued task-zone branches
  // below since only one of them ever mounts at a time.
  const idFade = useEdgeFade<HTMLDivElement>()
  const traitsFade = useEdgeFade<HTMLDivElement>()
  const stateFade = useEdgeFade<HTMLDivElement>()
  const tnIdFade = useEdgeFade<HTMLDivElement>()
  const tzMsgFade = useEdgeFade<HTMLSpanElement>()
  const fsFade = useEdgeFade<HTMLDivElement>()

  // Two independent bubbles: "task" shows the active job's full details,
  // "queued" lists every queued job for this drive. Mutually exclusive so
  // the (already small) card doesn't have to fit both open at once.
  //
  // Click is only wired up (see the JSX below: `supportsHover ? undefined :
  // togglePopover(...)`) on devices that don't really hover — there, it's
  // the only way in. On hover-capable devices it's hover alone; clicking the
  // task zone there just does the normal card-select click instead, same as
  // clicking anywhere else on the card. pinnedRef still exists to give
  // click-only devices the classic "click to open, click again to close"
  // toggle — it just never gets set on a hover-capable device, since the
  // click handler that sets it is never attached there.
  //
  // Rendered through a portal into document.body instead of inline in the
  // card: .drive-card needs overflow:hidden (its rounded left corners are
  // only correct when the accent bar gets clipped to the card's own
  // border-radius — the bar is too narrow for that radius to render right
  // on its own), which would otherwise clip a same-DOM-subtree popover
  // whenever there isn't much card left below the task zone, which is most
  // of the time. position:fixed lets it float free of that clip.
  //
  // Positioned at the pointer itself (e.clientX/Y), not the trigger's own
  // rect — anchoring to an element's top-left looked disconnected from the
  // cursor whenever you entered/clicked further along it (e.g. the queued
  // pill, at the right end). POPOVER_W/H are the CSS max-width/max-height
  // (kept in sync with DriveCard.css), used only to clamp away from viewport
  // edges before the real size is known.
  const [popover, setPopover] = useState<"task" | "queued" | null>(null)
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 })
  const pinnedRef = useRef(false)
  const hoverTimerRef = useRef<number | null>(null)
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)
  const pillRef = useRef<HTMLButtonElement>(null)

  // (hover: hover) is true for a device whose *primary* pointer can actually
  // hover (a mouse) — false for touch, even on a touchscreen laptop with a
  // mouse attached, if touch is what's currently driving. Read once at
  // mount; doesn't need to react to input switching mid-session for this.
  const [supportsHover] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches)

  const positionFrom = (e: { clientX: number; clientY: number }) => {
    const POPOVER_W = 280
    const POPOVER_H = 160
    setPopoverPos({
      top: Math.min(e.clientY + 12, window.innerHeight - POPOVER_H - 8),
      left: Math.max(8, Math.min(e.clientX, window.innerWidth - POPOVER_W - 8)),
    })
  }

  const cancelHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }

  const togglePopover = (which: "task" | "queued") => (e: React.MouseEvent) => {
    e.stopPropagation()
    cancelHoverTimer()
    setPopover(p => {
      if (p === which && pinnedRef.current) { pinnedRef.current = false; return null }
      pinnedRef.current = true
      positionFrom(e)
      return which
    })
  }

  // Mirrors the native title-attribute tooltip: only commits after the
  // pointer has been genuinely still for HOVER_DELAY_MS, hides the instant
  // it moves again, and re-arms from scratch without needing an exit/re-entry
  // — wired to both onMouseEnter and onMouseMove (below) so it re-evaluates
  // continuously, not just once at the boundary crossing.
  //
  // forceArm skips the distance check for onMouseEnter: crossing into a new
  // region (e.g. onto the queued pill) should always count as "moved" even
  // if the actual pixel delta from the last tracked point happens to be
  // tiny, since lastPosRef is shared across the whole task zone.
  //
  // The "task" arm call ignores movement that's actually within the queued
  // pill (pillRef.contains check) — mousemove bubbles (unlike enter/leave),
  // so without this the zone's handler would also fire for every movement
  // over the pill and fight with the pill's own arm calls.
  const MOVE_THRESHOLD = 4
  const armHover = (which: "task" | "queued", forceArm: boolean) => (e: React.MouseEvent) => {
    if (pinnedRef.current || !supportsHover) return
    if (which === "task" && pillRef.current?.contains(e.target as Node)) return
    const { clientX: x, clientY: y } = e
    const last = lastPosRef.current
    const moved = forceArm || !last || Math.hypot(x - last.x, y - last.y) > MOVE_THRESHOLD
    lastPosRef.current = { x, y }
    if (!moved) return
    cancelHoverTimer()
    setPopover(p => pinnedRef.current ? p : null)
    hoverTimerRef.current = window.setTimeout(() => {
      positionFrom({ clientX: x, clientY: y })
      setPopover(which)
    }, HOVER_DELAY_MS)
  }
  const disarmHover = () => {
    cancelHoverTimer()
    lastPosRef.current = null
    if (pinnedRef.current) return
    setPopover(null)
  }

  // Guards against a pending hover-intent timer firing setPopover after this
  // card has already unmounted (e.g. the job finished and the drive's task
  // zone re-rendered to a different branch, or the drive itself disappeared).
  useEffect(() => cancelHoverTimer, [])

  // Click-outside-to-dismiss (plus scroll, since a position:fixed popover
  // would otherwise drift away from the task zone it's anchored to): both
  // the trigger (togglePopover) and the popover's own onClick already call
  // stopPropagation, so a click on either of those never reaches this
  // document-level listener — only a click elsewhere does, which is exactly
  // the "outside" set we want to close on.
  useEffect(() => {
    if (!popover) return
    const close = () => { pinnedRef.current = false; setPopover(null) }
    document.addEventListener("click", close)
    window.addEventListener("scroll", close, true)
    return () => {
      document.removeEventListener("click", close)
      window.removeEventListener("scroll", close, true)
    }
  }, [popover])

  const popoverContent = popover && (popover === "queued" ? queuedJobs.length > 0 : !!job) && createPortal(
    <div className="dc-popover" style={popoverPos} onClick={e => e.stopPropagation()}>
      {popover === "task" && job && <JobDetailRows job={job} />}
      {popover === "queued" && queuedJobs.map(q => (
        <div key={q.id} className="dc-queued-item">
          <span className="dc-queued-op">{q.operation_name}</span>
          <span className="dc-queued-meta">{q.category} · queued {formatRelativeTime(q.created_at)}</span>
        </div>
      ))}
    </div>,
    document.body,
  )

  const startLabelEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setLabelInput(drive.label ?? "")
    setEditingLabel(true)
  }

  const commitLabelEdit = () => {
    setEditingLabel(false)
    if (cancelLabelEdit.current) {
      cancelLabelEdit.current = false
      return
    }
    const next = labelInput.trim() || null
    if (next !== drive.label) onLabelChange?.(drive.guid, next)
  }

  return (
    <div
      className={`drive-card bar-${health.bar}${selected ? " sel" : ""}`}
      onClick={onSelect}
    >
      {/* Row 1: name + badge */}
      <div className="dc-r1">
        <div className="dc-sel-btn" />
        <div ref={idFade.ref} className={`dc-r1-id${idFade.fade ? " dc-edge-fade" : ""}`}>
          {drive.manufacturer && <span className="dc-mfr">{drive.manufacturer}</span>}
          <span className="dc-model">{drive.model ?? drive.device}</span>
          {drive.capacity_bytes && <span className="dc-model dc-cap">{formatCapacity(drive.capacity_bytes)}</span>}
          {editingLabel ? (
            <input
              className="dc-label-input"
              autoFocus
              value={labelInput}
              placeholder="Label…"
              onClick={e => e.stopPropagation()}
              onChange={e => setLabelInput(e.target.value)}
              onBlur={commitLabelEdit}
              onKeyDown={e => {
                if (e.key === "Enter") e.currentTarget.blur()
                else if (e.key === "Escape") { cancelLabelEdit.current = true; e.currentTarget.blur() }
              }}
            />
          ) : drive.label ? (
            <span className="dc-label" onClick={startLabelEdit} title="Click to edit label">({drive.label})</span>
          ) : (
            <button className="dc-label-edit" onClick={startLabelEdit} title="Add label">
              <IconPencil size={14} />
            </button>
          )}
        </div>
        <span className={`dc-badge dc-badge-${health.bar}`}>{health.label}</span>
      </div>

      {/* Row 2: traits (left) + serial (right) */}
      <div className="dc-traits">
        <div ref={traitsFade.ref} className={`dc-traits-left${traitsFade.fade ? " dc-edge-fade" : ""}`}>
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
        {drive.serial && <span className="dc-serial"><IconBarcode size={13} />{drive.serial}</span>}
      </div>

      {/* Decorative leader line — 2/3 width */}
      <div className="dc-ldr"><div className="dc-ldr-line" /></div>

      {/* Row 3: active state — path + temp + mount status */}
      <div ref={stateFade.ref} className={`dc-state${stateFade.fade ? " dc-edge-fade" : ""}`}>
        <span className="dc-si"><IconServer size={11} /><span className="dc-sv">{drive.device}</span></span>
        {liveTemp !== null && (
          <>
            <span className="dc-tsep">·</span>
            <span className="dc-si" title={drive.vitals.temp_source ? `Source: ${drive.vitals.temp_source}` : undefined}>
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
      </div>

      {/* Task zone */}
      {job?.status === "running" ? (
        <div
          className="dc-tz running"
          onClick={supportsHover ? undefined : togglePopover("task")}
          onMouseEnter={armHover("task", true)}
          onMouseMove={armHover("task", false)}
          onMouseLeave={disarmHover}
        >
          <div className="dc-tn">
            <div ref={tnIdFade.ref} className={`dc-tn-id${tnIdFade.fade ? " dc-edge-fade" : ""}`}>
              <IconLoader2 size={11} className="spinning" />
              <span>{job.operation_name}</span>
            </div>
            {(job.progress.percent !== null || queuedJobs.length > 0) && (
              <div className="dc-tn-right">
                {queuedJobs.length > 0 && (
                  <button
                    ref={pillRef}
                    className="dc-queued-pill"
                    onClick={supportsHover ? undefined : togglePopover("queued")}
                    onMouseEnter={armHover("queued", true)}
                    onMouseMove={armHover("queued", false)}
                  >
                    {queuedJobs.length} queued
                  </button>
                )}
                {job.progress.percent !== null && <span className="dc-tz-pct">{job.progress.percent.toFixed(1)}%</span>}
              </div>
            )}
          </div>
          <div className="dc-tz-bar">
            {job.progress.percent === null
              ? <div className="dc-tz-bar-fill indeterminate" />
              : <div className="dc-tz-bar-fill" style={{ width: `${job.progress.percent}%` }} />}
          </div>
          {(job.progress.message || elapsedSeconds !== null) && (
            <div className="dc-tz-msg">
              {job.progress.message && (
                <span ref={tzMsgFade.ref} className={`dc-tz-msg-text${tzMsgFade.fade ? " dc-edge-fade" : ""}`}>
                  {job.progress.message}
                </span>
              )}
              {elapsedSeconds !== null && (
                <span className="dc-tz-time">
                  {formatDuration(elapsedSeconds)} · {remainingSeconds !== null ? `${formatDuration(remainingSeconds)} left` : "—"}
                </span>
              )}
            </div>
          )}
        </div>
      ) : job?.status === "queued" ? (
        <div
          className="dc-tz queued"
          onClick={supportsHover ? undefined : togglePopover("task")}
          onMouseEnter={armHover("task", true)}
          onMouseMove={armHover("task", false)}
          onMouseLeave={disarmHover}
        >
          <div className="dc-tn">
            <div ref={tnIdFade.ref} className={`dc-tn-id${tnIdFade.fade ? " dc-edge-fade" : ""}`}>
              <IconClock size={11} />
              <span>Queued: {job.operation_name}</span>
            </div>
            {queuedJobs.length > 0 && (
              <div className="dc-tn-right">
                <button
                  ref={pillRef}
                  className="dc-queued-pill"
                  onClick={supportsHover ? undefined : togglePopover("queued")}
                  onMouseEnter={armHover("queued", true)}
                  onMouseMove={armHover("queued", false)}
                >
                  {queuedJobs.length} queued
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="dc-tz idle">
          <div className="dc-tn">
            <IconClock size={11} />
            <span>Idle</span>
          </div>
        </div>
      )}
      {popoverContent}

      {/* Footer */}
      <div className="dc-ft">
        <div
          ref={fsFade.ref}
          className={`dc-fs${fsFade.fade ? " dc-edge-fade" : ""}`}
          title={drive.last_polled_at ? `Telemetry updated ${formatRelativeTime(drive.last_polled_at)}` : undefined}
        >
          {sigKeys.map(key => {
            const desc = SIGNALS[key]
            if (!desc) return null
            const val = drive[key as keyof Drive]
            const flag = drive.signal_flags?.[key]
            return (
              <Stat
                key={key}
                label={desc.label}
                value={desc.format(val)}
                warn={flag === "warn"}
                crit={flag === "crit"}
              />
            )
          })}
        </div>
        <div className="dc-io">
          <div className="dc-io-row rd">{formatThroughput(io.read_bytes_per_sec)}<IconArrowUp size={9} /></div>
          <div className="dc-io-row wr">{formatThroughput(io.write_bytes_per_sec)}<IconArrowDown size={9} /></div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, warn, crit }: { label: string; value: string | number; warn?: boolean; crit?: boolean }) {
  const cls = crit ? " crit" : warn ? " warn" : ""
  return (
    <div className="dc-stat">
      <div className="dc-stat-label">{label}</div>
      <div className={`dc-stat-value${cls}`}>{value}</div>
    </div>
  )
}

const HEALTH_DISPLAY: Record<string, { bar: "green" | "warn" | "red" | "grey"; label: string }> = {
  Healthy:  { bar: "green", label: "SMART OK" },
  Degraded: { bar: "warn",  label: "Degraded" },
  Failing:  { bar: "red",   label: "Failing"  },
  Unrated:  { bar: "grey",  label: "Unrated"  },
}

