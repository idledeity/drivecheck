import type { Drive, Job } from "./types"
import type { ConfirmRequest } from "./confirmContext"
import { formatDuration } from "./format"

/**
 * The question asked before cancelling these jobs, or null when none needs
 * asking: a plain job still waiting loses nothing, so it goes at once. A
 * batch step always asks, even unstarted, since cancelling it changes what
 * the rest of its batch does.
 */
export function jobCancelConfirmation(jobs: Job[], drives: Drive[]): ConfirmRequest | null {
  const running = jobs.filter(j => j.status === "running")
  const steps = jobs.filter(j => j.batch)
  if (running.length === 0 && steps.length === 0) return null
  const plural = jobs.length > 1

  let detail: string
  if (!plural) {
    const job = jobs[0]
    if (job.status === "running") {
      const drive = drives.find(d => d.guid === job.drive_guid)
      const where = drive ? ` on ${drive.label ?? drive.model ?? drive.device} (${drive.device})` : ""
      const elapsed = job.started_at ? (Date.now() - new Date(job.started_at).getTime()) / 1000 : null
      detail = `${job.operation_name} has been running${where}${elapsed !== null ? ` for ${formatDuration(elapsed)}` : ""}. That progress is lost.`
    } else {
      detail = `${job.operation_name} hasn't started yet.`
    }
    if (job.batch) detail += ` ${stepWarning(job)}`
  } else {
    detail = running.length ? `${running.length} of them ${running.length === 1 ? "is" : "are"} running. Their progress so far is lost.` : ""
    if (steps.length) detail += `${detail ? " " : ""}${steps.length === 1 ? "One is a batch step" : `${steps.length} are batch steps`}: a batch that stops on failure skips its later steps.`
  }

  const waiting = !plural && jobs[0].status !== "running"
  return {
    title: plural ? `Cancel ${jobs.length} tasks?` : `Cancel ${jobs[0].operation_name}?`,
    detail,
    confirmLabel: plural ? "Cancel tasks" : jobs[0].batch ? "Cancel step" : "Cancel task",
    cancelLabel: plural ? "Keep them" : waiting ? "Keep it" : "Keep running",
  }
}

// What cancelling one step does to the rest of its batch.
function stepWarning(job: Job): string {
  const batch = job.batch!
  const name = batch.recipe_name ?? "its batch"
  const which = `It's step ${batch.step + 1} of ${name}`
  return batch.stop_on_failure
    ? `${which}, which stops on failure: its later steps won't run.`
    : `${which}. Its later steps still run, without this one's result.`
}

/**
 * The question asked before cancelling a whole batch (its unfinished steps),
 * or null when none of them has started — same rule as single jobs.
 */
export function batchCancelConfirmation(steps: Job[], drives: Drive[]): ConfirmRequest | null {
  const running = steps.find(j => j.status === "running")
  if (!running) return null
  const name = running.batch?.recipe_name ?? "this batch"
  // As a plain job: what happens to the later steps is said below.
  const single = jobCancelConfirmation([{ ...running, batch: null }], drives)
  const rest = steps.length - 1
  return {
    title: `Cancel ${name}?`,
    detail: `${single?.detail ?? ""}${rest > 0 ? ` The ${rest} step${rest === 1 ? "" : "s"} after it won't run.` : ""}`,
    confirmLabel: "Cancel batch",
    cancelLabel: "Keep running",
  }
}
