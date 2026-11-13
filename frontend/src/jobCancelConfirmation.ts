import type { Drive, Job } from "./types"
import type { ConfirmRequest } from "./confirmContext"
import { formatDuration } from "./format"

/**
 * The question asked before cancelling these jobs, or null when none has
 * started: a job still waiting loses nothing, so it goes without asking.
 */
export function jobCancelConfirmation(jobs: Job[], drives: Drive[]): ConfirmRequest | null {
  const running = jobs.filter(j => j.status === "running")
  if (running.length === 0) return null
  const plural = jobs.length > 1

  let detail: string
  if (running.length === 1) {
    const job = running[0]
    const drive = drives.find(d => d.guid === job.drive_guid)
    const where = drive ? ` on ${drive.label ?? drive.model ?? drive.device} (${drive.device})` : ""
    const elapsed = job.started_at ? (Date.now() - new Date(job.started_at).getTime()) / 1000 : null
    detail = `${job.operation_name} has been running${where}${elapsed !== null ? ` for ${formatDuration(elapsed)}` : ""}. That progress is lost.`
  } else {
    detail = `${running.length} of them are running. Their progress so far is lost.`
  }

  return {
    title: plural ? `Cancel ${jobs.length} tasks?` : `Cancel ${jobs[0].operation_name}?`,
    detail,
    confirmLabel: plural ? "Cancel tasks" : "Cancel task",
    cancelLabel: plural ? "Keep them" : "Keep running",
  }
}
