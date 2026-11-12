import { useEffect, useMemo, useState } from "react"
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { FINISHED_STATUSES, mergeHistory } from "./jobHistory"
import { JobRow } from "./JobRow"
import { DriveChipHeader } from "./DriveChip"
import { Control, Segmented } from "./Controls"
import { formatDuration, toLocalIso } from "./format"
import "./ActivityTab.css"

interface Props {
  drives: Drive[]
  selectedGuids: string[]
  jobs: Job[]                 // App's live /api/jobs list, polled
  onCancel: (jobId: string) => void
  onMove: (jobId: string, direction: "up" | "down") => void
  unseen: Job[]               // finished jobs since the user last marked results seen
  onMarkSeen: () => void
  onShowHistory: () => void
}

type Recent = "off" | "last" | "1h" | "6h" | "1d" | "3d" | "7d"
const HOUR = 3600e3
const RECENT_MS: Record<Exclude<Recent, "off" | "last">, number> = { "1h": HOUR, "6h": 6 * HOUR, "1d": 24 * HOUR, "3d": 72 * HOUR, "7d": 168 * HOUR }
const RECENT_OPTIONS: { value: Recent; label: string }[] = [
  { value: "off", label: "Off" }, { value: "last", label: "Last only" },
  { value: "1h", label: "1h" }, { value: "6h", label: "6h" }, { value: "1d", label: "1d" }, { value: "3d", label: "3d" }, { value: "7d", label: "7d" },
]
// Finished jobs listed per lane; the rest are a click away in History.
const LANE_RECENT_CAP = 4

const finishedTime = (j: Job) => new Date(j.finished_at ?? j.created_at).getTime()

// What's running, what runs next on each drive, and how recent jobs ended:
// one lane per drive with something going on.
export default function ActivityTab({ drives, selectedGuids, jobs, onCancel, onMove, unseen, onMarkSeen, onShowHistory }: Props) {
  const [scope, setScope] = useState<"all" | "selected">("all")
  const [recent, setRecent] = useState<Recent>("3d")
  const [showIdle, setShowIdle] = useState(false)
  const maxParallel = useMaxParallel()
  const finished = useRecentFinished(recent, jobs)

  const running = jobs.filter(j => j.status === "running")
  const queued = jobs.filter(j => j.status === "queued").sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))
  const slotsFull = maxParallel !== null && running.length >= maxParallel

  // Known drives, plus any drive that has an active job but has since dropped
  // out of the drive list, so its job never goes missing from view.
  const guids = [...drives.map(d => d.guid), ...new Set([...running, ...queued].map(j => j.drive_guid).filter(g => !drives.some(d => d.guid === g)))]
  const lanes = guids.map(guid => {
    const run = running.find(j => j.drive_guid === guid)
    const next = queued.filter(j => j.drive_guid === guid)
    const done = finished.filter(j => j.drive_guid === guid)
    const recentDone = recent === "last" ? done.slice(0, 1) : done
    return { guid, drive: drives.find(d => d.guid === guid), run, next, recentDone, busy: !!run || next.length > 0 || recentDone.length > 0 }
  })
  const inScope = lanes.filter(l => scope === "all" || selectedGuids.includes(l.guid))
  const shown = inScope.filter(l => l.busy)
    // Running first, then waiting, then finished-only; grid order within each.
    .sort((a, b) => rank(a) - rank(b))
  const idle = inScope.filter(l => !l.busy)
  const hiddenBusy = lanes.filter(l => l.busy && !inScope.includes(l)).length
  const waitingForSlot = lanes.filter(l => !l.run && l.next.length > 0 && slotsFull).length
  const nextToFinish = running
    .filter(j => j.progress.eta_seconds !== null)
    .sort((a, b) => (a.progress.eta_seconds ?? 0) - (b.progress.eta_seconds ?? 0))[0]

  return (
    <div className="activity-tab">
      <section className="act-summary" aria-label="Summary">
        <div className="act-stats">
          <Stat label="Running" value={String(running.length)}
            sub={maxParallel === null ? "no parallel limit" : `of ${maxParallel} slot${maxParallel === 1 ? "" : "s"}`} />
          <Stat label="Queued" value={String(queued.length)}
            sub={waitingForSlot ? `${waitingForSlot} drive${waitingForSlot === 1 ? "" : "s"} waiting for a slot` : queued.length ? "run in the order shown" : "nothing waiting"} />
          {nextToFinish && (
            <Stat label="Next to finish" value={`~${formatDuration(nextToFinish.progress.eta_seconds ?? 0)}`}
              sub={`${nextToFinish.operation_name} · ${driveName(drives, nextToFinish.drive_guid)}`} />
          )}
        </div>
        <div className="act-news">
          <div className="act-news-head">
            <h3 className="act-news-title">
              {unseen.length ? `New since you last looked (${unseen.length})` : "Nothing new since you last looked"}
            </h3>
            {unseen.length > 0 && <button className="act-seen-btn" onClick={onMarkSeen}>Mark seen</button>}
          </div>
          {unseen.slice(0, 8).map(job => (
            <JobRow key={job.id} job={job} drive={drives.find(d => d.guid === job.drive_guid)} onCancel={onCancel} />
          ))}
          {unseen.length > 8 && (
            <button className="act-link" onClick={onShowHistory}>{unseen.length - 8} more in History</button>
          )}
        </div>
      </section>

      <div className="filter-row">
        <Control label="Drives">
          <Segmented label="Drives" idPrefix="activity-scope" value={scope} onChange={setScope} options={[
            { value: "all", label: "All" },
            { value: "selected", label: `Selected (${selectedGuids.length})`, disabled: selectedGuids.length === 0, title: selectedGuids.length ? undefined : "Select drives in the grid first" },
          ]} />
        </Control>
        <Control label="Recently finished">
          <Segmented label="Recently finished" idPrefix="activity-recent" value={recent} onChange={setRecent} options={RECENT_OPTIONS} />
        </Control>
        <label className="ctl-check"><input type="checkbox" id="activity-idle" checked={showIdle} onChange={e => setShowIdle(e.target.checked)} /> Show idle drives</label>
      </div>

      {shown.length === 0 && <p className="act-empty">Nothing running or queued{recent === "off" ? "" : ", and nothing finished in this window"}.</p>}

      {shown.map(lane => (
        <section key={lane.guid} className="act-lane" aria-label={driveName(drives, lane.guid)}>
          <div className="act-lane-top">
            <DriveChipHeader drive={lane.drive} className="act-lane-chip" />
            <LaneState lane={lane} slotsFull={slotsFull} />
          </div>
          {lane.run && <JobRow job={lane.run} drive={lane.drive} onCancel={onCancel} />}
          {lane.next.length > 0 && (
            <>
              <h4 className="act-sub">Up next</h4>
              <ol className="act-queue">
                {lane.next.map((job, i) => (
                  <li key={job.id} className="act-q-row">
                    <span className="act-q-n">{i + 1}</span>
                    <span className="act-q-op">
                      {job.operation_name}
                      {/* The one case the order doesn't explain: the drive is free but every slot is taken. */}
                      {i === 0 && !lane.run && slotsFull && (
                        <span className="act-q-why">Waits for a free slot ({running.length} of {maxParallel} running)</span>
                      )}
                    </span>
                    <span className="act-q-actions">
                      <button className="icon-btn" title="Move up" aria-label={`Move up: ${job.operation_name}`} disabled={i === 0} onClick={() => onMove(job.id, "up")}>
                        <IconChevronUp size={14} />
                      </button>
                      <button className="icon-btn" title="Move down" aria-label={`Move down: ${job.operation_name}`} disabled={i === lane.next.length - 1} onClick={() => onMove(job.id, "down")}>
                        <IconChevronDown size={14} />
                      </button>
                      <button className="icon-btn act-q-cancel" title="Cancel" aria-label={`Cancel: ${job.operation_name}`} onClick={() => onCancel(job.id)}>
                        <IconX size={14} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {lane.recentDone.length > 0 && (
            <>
              <h4 className="act-sub">{recent === "last" ? "Last result" : "Recently finished"}</h4>
              {lane.recentDone.slice(0, LANE_RECENT_CAP).map(job => (
                <JobRow key={job.id} job={job} drive={lane.drive} onCancel={onCancel} />
              ))}
              {lane.recentDone.length > LANE_RECENT_CAP && (
                <button className="act-link" onClick={onShowHistory}>{lane.recentDone.length - LANE_RECENT_CAP} more in History</button>
              )}
            </>
          )}
        </section>
      ))}

      {hiddenBusy > 0 && (
        <p className="act-empty">
          {hiddenBusy} busy drive{hiddenBusy === 1 ? "" : "s"} hidden by the Selected filter ·{" "}
          <button className="act-link" onClick={() => setScope("all")}>Show all</button>
        </p>
      )}
      {idle.length > 0 && (showIdle ? (
        <section className="act-lane act-idle" aria-label="Idle drives">
          <h4 className="act-sub">Idle drives ({idle.length})</h4>
          {idle.map(lane => <DriveChipHeader key={lane.guid} drive={lane.drive} />)}
        </section>
      ) : (
        <p className="act-empty">{idle.length} idle drive{idle.length === 1 ? "" : "s"} hidden</p>
      ))}
    </div>
  )
}

type Lane = { run?: Job; next: Job[]; recentDone: Job[] }
const rank = (l: Lane) => (l.run ? 0 : l.next.length ? 1 : 2)

function LaneState({ lane, slotsFull }: { lane: Lane; slotsFull: boolean }) {
  if (lane.run) return <span className="act-state run">Running</span>
  if (lane.next.length) return <span className="act-state wait">{slotsFull ? "Waiting for a slot" : "Starting"}</span>
  return <span className="act-state done">Finished</span>
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="act-stat">
      <div className="act-stat-label">{label}</div>
      <div className="act-stat-value">{value}</div>
      <div className="act-stat-sub">{sub}</div>
    </div>
  )
}

function driveName(drives: Drive[], guid: string): string {
  const d = drives.find(x => x.guid === guid)
  if (!d) return "Unknown drive"
  return [d.label ?? d.model ?? d.device, d.serial?.slice(-4)].filter(Boolean).join(" ")
}

// jobs.max_parallel from the config; null when uncapped (or not loaded yet).
function useMaxParallel(): number | null {
  const [value, setValue] = useState<number | null>(null)
  useEffect(() => {
    let current = true
    fetch("/api/config")
      .then(r => r.json())
      .then((props: { key: string; value: unknown }[]) => {
        const v = Array.isArray(props) ? props.find(p => p.key === "jobs.max_parallel")?.value : null
        if (current) setValue(typeof v === "number" && v > 0 ? v : null)
      })
      .catch(() => {})
    return () => { current = false }
  }, [])
  return value
}

// Finished jobs for the "Recently finished" window, newest first: stored rows
// (fetched once per window) overlaid with live jobs that just finished.
// "Last only" fetches without a window and keeps each drive's newest.
function useRecentFinished(recent: Recent, liveJobs: Job[]): Job[] {
  const [stored, setStored] = useState<{ recent: Recent; since: number | null; jobs: Job[] } | null>(null)

  useEffect(() => {
    if (recent === "off") return
    const since = recent === "last" ? null : Date.now() - RECENT_MS[recent]
    let current = true
    fetch(`/api/jobs/history?limit=500${since === null ? "" : `&since=${encodeURIComponent(toLocalIso(since))}`}`)
      .then(r => r.json())
      .then((rows: Job[]) => { if (current) setStored({ recent, since, jobs: Array.isArray(rows) ? rows : [] }) })
      .catch(() => { if (current) setStored({ recent, since, jobs: [] }) })
    return () => { current = false }
  }, [recent])

  return useMemo(() => {
    if (recent === "off" || stored?.recent !== recent) return []
    const live = liveJobs.filter(j => FINISHED_STATUSES.has(j.status) && (stored.since === null || finishedTime(j) >= stored.since))
    return mergeHistory(stored.jobs, live)
      .filter(j => FINISHED_STATUSES.has(j.status))
      .sort((a, b) => finishedTime(b) - finishedTime(a))
  }, [recent, stored, liveJobs])
}
