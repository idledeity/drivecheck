import { useEffect, useMemo, useState } from "react"
import type { Drive, Job } from "./types"
import { FINISHED_STATUSES, mergeHistory } from "./jobHistory"
import { groupTasks, type TaskItem } from "./taskItems"
import { TaskRow } from "./BatchRow"
import { DriveChipHeader } from "./DriveChip"
import { Control, Segmented } from "./Controls"
import { formatDuration, toServerIso } from "./format"
import "./ActivityTab.css"

interface Props {
  drives: Drive[]
  selectedGuids: string[]
  jobs: Job[]                 // App's live /api/jobs list, polled
  onCancel: (jobId: string) => void
  onMove: (jobId: string, direction: "up" | "down") => void
  onCancelBatch: (batchId: string) => void
  onMoveBatch: (batchId: string, direction: "up" | "down") => void
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
export default function ActivityTab({ drives, selectedGuids, jobs, onCancel, onMove, onCancelBatch, onMoveBatch, unseen, onMarkSeen, onShowHistory }: Props) {
  const [scope, setScope] = useState<"all" | "selected">("all")
  const [recent, setRecent] = useState<Recent>("3d")
  const [showIdle, setShowIdle] = useState(false)
  const maxParallel = useMaxParallel()
  const finished = useRecentFinished(recent, jobs)
  // Every job known here, for finding all of a batch's steps.
  const pool = useMemo(() => mergeHistory(finished, jobs), [finished, jobs])

  const running = jobs.filter(j => j.status === "running")
  const queued = jobs.filter(j => j.status === "queued").sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))
  const slotsFull = maxParallel !== null && running.length >= maxParallel

  // Known drives, plus any drive that has an active job but has since dropped
  // out of the drive list, so its job never goes missing from view.
  const guids = [...drives.map(d => d.guid), ...new Set([...running, ...queued].map(j => j.drive_guid).filter(g => !drives.some(d => d.guid === g)))]
  const lanes = guids.map(guid => {
    const run = running.find(j => j.drive_guid === guid)
    const next = queued.filter(j => j.drive_guid === guid)
    // A batch still going shows whole where it runs or waits, not here.
    const activeBatches = new Set([run, ...next].map(j => j?.batch?.id).filter(Boolean))
    const done = groupTasks(finished.filter(j => j.drive_guid === guid && !activeBatches.has(j.batch?.id)), pool)
    const recentDone = recent === "last" ? done.slice(0, 1) : done
    // The running job's batch takes its queued steps along.
    const runItem = run ? groupTasks([run], pool)[0] : undefined
    const nextItems = groupTasks(next.filter(j => !run?.batch || j.batch?.id !== run.batch.id), pool)
    return { guid, drive: drives.find(d => d.guid === guid), run, runItem, next: nextItems, recentDone, busy: !!run || next.length > 0 || recentDone.length > 0 }
  })
  const inScope = lanes.filter(l => scope === "all" || selectedGuids.includes(l.guid))
  const shown = inScope.filter(l => l.busy)
    // Running first, then waiting, then finished-only; grid order within each.
    .sort((a, b) => rank(a) - rank(b))
  const idle = inScope.filter(l => !l.busy)
  const hiddenBusy = lanes.filter(l => l.busy && !inScope.includes(l)).length
  const waitingForSlot = lanes.filter(l => !l.run && l.next.length > 0 && slotsFull).length
  const news = groupTasks(unseen, pool)
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
              {news.length ? `New since you last looked (${news.length})` : "Nothing new since you last looked"}
            </h3>
            {unseen.length > 0 && <button className="act-seen-btn" onClick={onMarkSeen}>Mark seen</button>}
          </div>
          {news.slice(0, 8).map(item => (
            <TaskRow key={item.key} item={item} drive={drives.find(d => d.guid === itemGuid(item))} onCancel={onCancel} onCancelBatch={onCancelBatch} />
          ))}
          {news.length > 8 && (
            <button className="act-link" onClick={onShowHistory}>{news.length - 8} more in History</button>
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
          <LaneQueue lane={lane} waitsForSlot={!lane.run && slotsFull}
            slotNote={`Waits for a free slot (${running.length} of ${maxParallel} running)`}
            onCancel={onCancel} onMove={onMove} onCancelBatch={onCancelBatch} onMoveBatch={onMoveBatch} />
          {lane.recentDone.length > 0 && (
            <>
              <h4 className="act-sub">{recent === "last" ? "Last result" : "Recently finished"}</h4>
              {lane.recentDone.slice(0, LANE_RECENT_CAP).map(item => (
                <TaskRow key={item.key} item={item} drive={lane.drive} onCancel={onCancel} onCancelBatch={onCancelBatch} />
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

type Lane = { drive?: Drive; run?: Job; runItem?: TaskItem; next: TaskItem[]; recentDone: TaskItem[] }
const rank = (l: Lane) => (l.run ? 0 : l.next.length ? 1 : 2)
const itemGuid = (item: TaskItem) => (item.kind === "job" ? item.job : item.steps[0]).drive_guid

// A batch has started once any of its steps has left the queue; its
// remaining steps then stay next on the drive.
const batchStarted = (steps: Job[]) => steps.some(j => j.status !== "queued")
const PINNED_TITLE = "Started — its remaining steps run next on this drive"

type QueueHandlers = Pick<Props, "onCancel" | "onMove" | "onCancelBatch" | "onMoveBatch">

// The running task and the drive's queue, as task rows. A batch is one row
// with its steps inside; it moves as a whole, and once started nothing moves
// past it.
function LaneQueue({ lane, waitsForSlot, slotNote, onCancel, onMove, onCancelBatch, onMoveBatch }: {
  lane: Lane; waitsForSlot: boolean; slotNote: string
} & QueueHandlers) {
  const units = lane.next
  const pinnedFirst = units[0]?.kind === "batch" && batchStarted(units[0].steps)
  const move = (item: TaskItem, direction: "up" | "down") =>
    () => (item.kind === "job" ? onMove(item.job.id, direction) : onMoveBatch(item.batchId, direction))

  return (
    <>
      {lane.runItem && <TaskRow item={lane.runItem} drive={lane.drive} onCancel={onCancel} onCancelBatch={onCancelBatch} />}
      {units.length > 0 && (
        <>
          <h4 className="act-sub">Up next</h4>
          <div className="act-queue">
            {units.map((item, i) => {
              const pinned = i === 0 && pinnedFirst
              const upBlocked = i === 0 || (i === 1 && pinnedFirst)
              const downBlocked = i === units.length - 1 || pinned
              return (
                <TaskRow key={item.key} item={item} drive={lane.drive} onCancel={onCancel} onCancelBatch={onCancelBatch} queue={{
                  n: i + 1,
                  up: upBlocked ? null : move(item, "up"),
                  down: downBlocked ? null : move(item, "down"),
                  label: item.kind === "job" ? item.job.operation_name : item.steps[0].batch?.recipe_name ?? "Batch",
                  title: pinned ? PINNED_TITLE : undefined,
                  // The one case the order doesn't explain: the drive is free but every slot is taken.
                  note: i === 0 && waitsForSlot ? slotNote : undefined,
                }} />
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

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
    fetch(`/api/jobs/history?limit=500${since === null ? "" : `&since=${encodeURIComponent(toServerIso(since))}`}`)
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
