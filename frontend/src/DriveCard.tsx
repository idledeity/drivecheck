import { useState } from "react"
import { createPortal } from "react-dom"
import { IconArrowDown, IconArrowUp, IconClock, IconLoader2, IconServer, IconTemperature } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { SIGNALS, DEFAULT_FOOTER_SIGNALS } from "./signals"
import SignalValue from "./SignalValue"
import { formatCapacity, formatRelativeTime, formatThroughput } from "./format"
import { JobDetailRows } from "./JobDetails"
import { JobRow } from "./JobRow"
import CancelJobButton from "./CancelJobButton"
import { useJobs } from "./jobsContext"
import DriveOverview from "./DriveOverview"
import { useEdgeFade } from "./useEdgeFade"
import { useHoverPopover } from "./useHoverPopover"
import { useJobTiming } from "./useJobTiming"
import { useLongPress } from "./useLongPress"
import Serial from "./Serial"
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
  /** A drive menu is open: no hover popovers, so none can open over it. */
  menuOpen?: boolean
}

// How long the pointer has to sit still over a trigger before the hover
// preview commits — tune this to taste. Intentionally not instant: a short
// "hover intent" delay is what stops the bubble flashing open on every
// incidental mouse pass-through on the way to somewhere else on the card.
const HOVER_DELAY_MS = 400

export default function DriveCard({ drive, selected, onSelect, onSelectToggle, onContextMenu, footerSignals, job, queuedJobs, newResults = [], menuOpen = false }: Props) {
  const health  = drive.health_status ? HEALTH_DISPLAY[drive.health_status] : HEALTH_DISPLAY.Unrated
  const tempHot = drive.signal_flags?.temp === "warn"
  const sigMap  = footerSignals ?? DEFAULT_FOOTER_SIGNALS
  const sigKeys = sigMap[drive.drive_type ?? "default"] ?? sigMap["default"]
  const liveTemp = drive.vitals.temp ?? drive.temp
  const io = drive.vitals.io

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
  const { cancelJob } = useJobs()

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

  const jobRows = (jobs: Job[]) => jobs.map(j => <JobRow key={j.id} job={j} drive={drive} onCancel={cancelJob} compact />)
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
    queued: queuedJobs.length > 0 && jobRows(queuedJobs),
    complete: newResults.length > 0 && jobRows(newResults),
    health: <DriveOverview drive={drive} header={false} />,
  }[pop.open ?? "task"]
  const popoverContent = pop.open && popoverBody && createPortal(
    <div className={`dc-popover${pop.open === "task" ? "" : " dc-popover-wide"}`} style={pop.pos} {...pop.popoverProps}>
      {popoverBody}
    </div>,
    document.body,
  )

  // Yellow text, never an outcome color: green/red on a drive card always
  // means health. How each job ended is in its popover (status icon) and on
  // the Activity tab.
  const completePill = newResults.length > 0 && (
    <button className="dc-complete-pill" {...pop.trigger("complete")}>
      {newResults.length} complete
    </button>
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
        <span className={`dc-badge dc-badge-${health.bar}`} {...pop.trigger("health")}>{health.label}</span>
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
          {...pop.trigger("task")}
        >
          <div className="dc-tn">
            <div ref={tnIdFadeRef} className={`dc-tn-id${tnIdFaded ? " dc-edge-fade" : ""}`}>
              <IconLoader2 size={11} className="spinning" />
              <span>{job.operation_name}</span>
            </div>
            <div className="dc-tn-right">
              {queuedJobs.length > 0 && (
                <button className="dc-queued-pill" {...pop.trigger("queued")}>
                  {queuedJobs.length} queued
                </button>
              )}
              {completePill}
              <CancelJobButton job={job} drive={drive} onCancel={cancelJob} />
            </div>
          </div>
          {/* The percent sits at the end of the bar it describes, leaving the
              name row room for the name, the pills and the ×. */}
          <div className="dc-tz-bar-row">
            <div className="dc-tz-bar">
              {job.progress.percent === null
                ? <div className="dc-tz-bar-fill indeterminate" />
                : <div className="dc-tz-bar-fill" style={{ width: `${job.progress.percent}%` }} />}
            </div>
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
          <div className="dc-tn">
            <div ref={tnIdFadeRef} className={`dc-tn-id${tnIdFaded ? " dc-edge-fade" : ""}`}>
              <IconClock size={11} />
              <span>Queued: {job.operation_name}</span>
            </div>
            <div className="dc-tn-right">
              {queuedJobs.length > 0 && (
                <button className="dc-queued-pill" {...pop.trigger("queued")}>
                  {queuedJobs.length} queued
                </button>
              )}
              {completePill}
              <CancelJobButton job={job} drive={drive} onCancel={cancelJob} />
            </div>
          </div>
        </div>
      ) : (
        <div className="dc-tz idle">
          <div className="dc-tn">
            <IconClock size={11} />
            <span>Idle</span>
            {completePill && <div className="dc-tn-right">{completePill}</div>}
          </div>
        </div>
      )}
      {popoverContent}

      {/* Footer */}
      <div className="dc-ft">
        <div
          ref={fsFadeRef}
          className={`dc-fs${fsFaded ? " dc-edge-fade" : ""}`}
          title={drive.last_polled_at ? `Telemetry updated ${formatRelativeTime(drive.last_polled_at)}` : undefined}
        >
          {sigKeys.map(key => {
            const desc = SIGNALS[key]
            if (!desc) return null
            return (
              <div key={key} className="dc-stat">
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
        <div className="dc-io">
          <div className="dc-io-row rd">{formatThroughput(io.read_bytes_per_sec)}<IconArrowUp size={9} /></div>
          <div className="dc-io-row wr">{formatThroughput(io.write_bytes_per_sec)}<IconArrowDown size={9} /></div>
        </div>
      </div>
    </div>
  )
}

type PopoverKey = "task" | "queued" | "complete" | "health"

const HEALTH_DISPLAY: Record<string, { bar: "green" | "warn" | "red" | "grey"; label: string }> = {
  Healthy:  { bar: "green", label: "SMART OK" },
  Degraded: { bar: "warn",  label: "Degraded" },
  Failing:  { bar: "red",   label: "Failing"  },
  Unrated:  { bar: "grey",  label: "Unrated"  },
}
