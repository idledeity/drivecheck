import type { Job, JobStatus } from "./types"

// What a task list shows, one entry each: a standalone job, or a batch with
// every step of it that's known (live or stored), in step order.
export type TaskItem =
  | { kind: "job"; key: string; job: Job }
  | { kind: "batch"; key: string; batchId: string; steps: Job[] }

/**
 * Groups jobs into task items, in the order the jobs come: a batch appears
 * where its first listed step would, once. Its steps come from `pool` (every
 * job known to the caller), so a batch listed for one finished step still
 * shows them all. A job in a batch is always in the batch's steps, even when
 * the pool lacks it.
 */
export function groupTasks(jobs: Job[], pool: Job[] = jobs): TaskItem[] {
  const steps = batchSteps([...pool, ...jobs])
  const items: TaskItem[] = []
  const seen = new Set<string>()
  for (const job of jobs) {
    const id = job.batch?.id
    if (!id) { items.push({ kind: "job", key: job.id, job }); continue }
    if (seen.has(id)) continue
    seen.add(id)
    items.push({ kind: "batch", key: `batch-${id}`, batchId: id, steps: steps.get(id)! })
  }
  return items
}

/** Each batch's steps among these jobs (one per job id, in step order). */
export function batchSteps(jobs: Job[]): Map<string, Job[]> {
  const byBatch = new Map<string, Map<string, Job>>()
  for (const job of jobs) {
    const id = job.batch?.id
    if (!id) continue
    const steps = byBatch.get(id) ?? new Map<string, Job>()
    // Later entries win: callers list live jobs after stored rows.
    steps.set(job.id, job)
    byBatch.set(id, steps)
  }
  return new Map([...byBatch].map(([id, steps]) => [id, [...steps.values()].sort((a, b) => a.batch!.step - b.batch!.step)]))
}

const ACTIVE = new Set<JobStatus>(["queued", "running"])
export const isActive = (job: Job) => ACTIVE.has(job.status)

// How a batch stands, derived from its steps (never stored).
export type BatchState = {
  status: JobStatus          // running (also between steps), queued (none started), or how it ended
  total: number              // its step count
  current: Job | null        // the running step, or the next one between steps
  ended: Job | null          // the step that ended it early (failed, cancelled, interrupted)
  completed: number
  skipped: number
  startedAt: string | null   // first step's start
  finishedAt: string | null  // last step's end, once every step has ended
}

export function batchState(steps: Job[]): BatchState {
  // Every step is created up front: the last one's number gives the count
  // even when some of the batch's rows aren't loaded.
  const total = Math.max(steps.length, ...steps.map(j => (j.batch?.step ?? 0) + 1))
  const running = steps.find(j => j.status === "running") ?? null
  const queued = steps.filter(j => j.status === "queued")
  const ended = steps.find(j => j.status === "failed" || j.status === "interrupted" || j.status === "cancelled") ?? null
  const started = steps.filter(j => j.started_at).map(j => j.started_at!).sort()
  const finished = steps.filter(j => j.finished_at).map(j => j.finished_at!).sort()
  let status: JobStatus
  if (running || (queued.length > 0 && queued.length < steps.length)) status = "running"
  else if (queued.length > 0) status = "queued"
  else status = ended?.status ?? "completed"
  return {
    status,
    total,
    current: running ?? (status === "running" ? queued[0] : null),
    ended,
    completed: steps.filter(j => j.status === "completed").length,
    skipped: steps.filter(j => j.status === "skipped").length,
    startedAt: started[0] ?? null,
    finishedAt: queued.length || running ? null : finished.at(-1) ?? null,
  }
}

/** The status a task item shows: a job's own, or its batch's derived one. */
export function itemStatus(item: TaskItem): JobStatus {
  return item.kind === "job" ? item.job.status : batchState(item.steps).status
}

/** The jobs behind a task item. */
export const itemJobs = (item: TaskItem): Job[] => (item.kind === "job" ? [item.job] : item.steps)

/** When the item finished (or was created, if it hasn't), in ms. */
export function itemFinishedAt(item: TaskItem): number {
  const jobs = itemJobs(item)
  return Math.max(...jobs.map(j => new Date(j.finished_at ?? j.created_at).getTime()))
}

/** How long it ran, first start to last finish, in ms; -1 if it never ran. */
export function itemDuration(item: TaskItem): number {
  const jobs = itemJobs(item)
  const starts = jobs.filter(j => j.started_at && j.finished_at).map(j => new Date(j.started_at!).getTime())
  if (!starts.length) return -1
  const ends = jobs.filter(j => j.finished_at).map(j => new Date(j.finished_at!).getTime())
  return Math.max(...ends) - Math.min(...starts)
}

/** A batch's one-line outcome, for its header. */
export function batchOutcome(state: BatchState, stopOnFailure: boolean | null): string {
  const stops = stopOnFailure ? " · stops on failure" : ""
  const skipped = state.skipped ? ` · ${state.skipped} skipped` : ""
  switch (state.status) {
    case "queued":
      return stopOnFailure ? "Stops on failure" : ""
    case "running":
      return state.current
        ? `${state.current.operation_name} ${state.current.status === "running" ? "running" : "next"}${stops}`
        : `In progress${stops}`
    case "completed":
      return state.completed === state.total ? `All ${state.total} steps completed` : `${state.completed} of ${state.total} steps completed${skipped}`
    case "failed":
      return `Failed at ${state.ended?.operation_name ?? "a step"}${skipped}`
    case "cancelled":
      return `Cancelled at ${state.ended?.operation_name ?? "a step"}${skipped}`
    case "interrupted":
      return `Interrupted at ${state.ended?.operation_name ?? "a step"}${skipped}`
    case "skipped":
      return "Skipped"
  }
}
