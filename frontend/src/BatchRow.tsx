import { useEffect, useState } from "react"
import { IconX } from "@tabler/icons-react"
import type { Drive, Job, JobBatch } from "./types"
import { formatClock, formatDuration, formatRelativeTime } from "./format"
import { useConfirm } from "./confirmContext"
import { batchCancelConfirmation } from "./jobCancelConfirmation"
import { batchOutcome, batchState, type TaskItem } from "./taskItems"
import { JobRow, QueueMoveButtons, type QueueSlot } from "./JobRow"
import { STATUS_ICON } from "./jobStatusIcon"
import { smartRiseNote, smartRises } from "./smartRises"
import DriveChip from "./DriveChip"
import "./JobRow.css"

// A batch as one task row: the same header as a job's (status icon, drive
// chip, a pill naming the recipe, outcome, time, ×), a strip with one segment
// per step, then its steps as lines inside the row, each expanding to its own
// details. Clicking the header folds the steps away. Status and outcome are
// derived from the steps. The batch moves and cancels as one; a step can
// still be cancelled on its own.
export function BatchRow({ steps, drive, onCancel, onCancelBatch, compact = false, queue }: {
  steps: Job[]
  drive: Drive | undefined
  onCancel: (jobId: string) => void
  onCancelBatch: (batchId: string) => void
  compact?: boolean
  queue?: QueueSlot
}) {
  const [open, setOpen] = useState(true)
  const confirm = useConfirm()
  const batch = steps[0].batch!
  const state = batchState(steps)
  const name = batch.recipe_name ?? "Batch"
  const active = state.status === "running" || state.status === "queued"
  const now = useNow(state.status === "running")
  const count = state.status === "queued" ? `${state.total} steps`
    : active ? `${(state.current?.batch?.step ?? 0) + 1} / ${state.total}`
    : `${state.completed} / ${state.total}`
  const outcome = batchOutcome(state, batch.stop_on_failure)
  const bad = state.status === "failed" || state.status === "interrupted"
  const time = active
    ? state.startedAt
      ? `started ${formatClock(state.startedAt)} · ${formatDuration((now - new Date(state.startedAt).getTime()) / 1000)}`
      : `queued ${formatClock(steps[0].created_at)}`
    : state.finishedAt
      ? `${state.startedAt ? `${formatDuration((new Date(state.finishedAt).getTime() - new Date(state.startedAt).getTime()) / 1000)} · ` : ""}${formatRelativeTime(state.finishedAt)}`
      : null
  const smart = batchSmartLine(batch.smart, state.startedAt !== null, active)
  const segments = Array.from({ length: state.total }, (_, i) => steps.find(j => j.batch?.step === i)?.status ?? "queued")

  const cancelBatch = (e: React.MouseEvent) => {
    e.stopPropagation()
    const request = batchCancelConfirmation(steps.filter(j => j.status === "running" || j.status === "queued"), drive ? [drive] : [])
    if (!request) { onCancelBatch(batch.id); return }
    void confirm(request).then(ok => { if (ok) onCancelBatch(batch.id) })
  }

  return (
    <div className={`queue-row batch-row queue-row-${state.status}${compact ? " compact" : ""}`} role="group" aria-label={`Batch: ${name}`}>
      <div className="queue-row-main" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="queue-lead">
          {queue && <span className="queue-n">{queue.n}</span>}
          <span className={`queue-status-icon queue-status-${state.status}`}>{STATUS_ICON[state.status]}</span>
        </span>
        {compact ? null : drive
          ? <span className="queue-drive-id"><DriveChip drive={drive} serial="tail" /></span>
          : <span className="queue-drive-id">{steps[0].drive_guid}</span>}
        <span className="queue-op batch">{name}<span className="queue-op-count">{count}</span></span>
        {queue?.note
          ? <span className="queue-note">{queue.note}</span>
          : outcome && <span className={`queue-outcome${bad ? " bad" : ""}`} title={outcome}>{outcome}</span>}
        <div className="queue-right">
          {time && <span className="queue-time">{time}</span>}
          {queue && <QueueMoveButtons queue={queue} />}
          {active && (
            <button className="queue-cancel" title="Cancel batch" aria-label={`Cancel batch: ${name}`} onClick={cancelBatch}>
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="batch-strip" aria-hidden="true">
        {segments.map((status, i) => <span key={i} className={`batch-seg ${status}`} />)}
      </div>
      {smart && <div className={`batch-smart ${smart.tone}`} title={smart.title}>{smart.text}</div>}
      {open && (
        <div className="batch-steps">
          {steps.map(job => <JobRow key={job.id} job={job} drive={drive} onCancel={onCancel} compact={compact} step />)}
        </div>
      )}
    </div>
  )
}

// A task item as its row: a job's JobRow, or a batch's BatchRow.
export function TaskRow({ item, drive, onCancel, onCancelBatch, compact, queue }: {
  item: TaskItem
  drive: Drive | undefined
  onCancel: (jobId: string) => void
  onCancelBatch: (batchId: string) => void
  compact?: boolean
  queue?: QueueSlot
}) {
  return item.kind === "job"
    ? <JobRow job={item.job} drive={drive} onCancel={onCancel} compact={compact} queue={queue} />
    : <BatchRow steps={item.steps} drive={drive} onCancel={onCancel} onCancelBatch={onCancelBatch} compact={compact} queue={queue} />
}

// The batch's SMART change across its steps run so far (batch.smart: first
// step's "before" → last step's "after"), as a line under the strip once a
// step has run. Each step's own change is on its step line.
function batchSmartLine(span: JobBatch["smart"], ran: boolean, active: boolean): { text: string; title: string; tone: string } | null {
  // Nothing yet while the first step runs (no "after" to compare with).
  if (!ran || (active && !span)) return null
  const during = active ? "SMART so far" : "SMART during batch"
  const rises = smartRises(span)
  if (rises.length) {
    const text = `${during}: ${rises.map(r => r.full).join(", ")}`
    return { text, title: text, tone: "worse" }
  }
  const note = smartRiseNote(span, true, "this batch")
  if (note) return { text: `${during}: not compared`, title: note.title, tone: "unknown" }
  return { text: `${during}: no error counters rose`, title: "No error counter rose and SMART status didn't fail", tone: "same" }
}

// The time, ticking once a second while `live` (a running batch's elapsed time).
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])
  return now
}
