import { createContext, useContext } from "react"
import type { Job } from "./types"

export type JobsContextValue = {
  /** App's live /api/jobs list, polled. */
  jobs: Job[]
  /** Finished jobs since the user last marked results seen, newest first. */
  unseen: Job[]
  /** Each drive's last finished task: one job, or every step of its batch. */
  lastTasks: Map<string, Job[]>
  cancelJob: (jobId: string) => void
  /** Move a queued job one place earlier or later among its drive's queued jobs. */
  moveJob: (jobId: string, direction: "up" | "down") => void
  /** Cancel a batch: its queued steps at once, its running one as it stops. */
  cancelBatch: (batchId: string) => void
  /** Move a batch's queued steps, together, one place earlier or later. */
  moveBatch: (batchId: string, direction: "up" | "down") => void
  /** Queue the operation on each drive; resolves to the server's reason if it refused, else null. */
  runOperation: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<string | null>
  /** Start a recipe: one batch per drive. Resolves to the server's reason if it refused, else null. */
  runRecipe: (guids: string[], recipe: string, params: Record<string, unknown>, stopOnFailure: boolean) => Promise<string | null>
  /** Count every job finished so far as seen. */
  markJobsSeen: () => void
}

// The no-op default keeps components usable outside App (tests, previews).
export const JobsContext = createContext<JobsContextValue>({
  jobs: [],
  unseen: [],
  lastTasks: new Map(),
  cancelJob: () => {},
  moveJob: () => {},
  cancelBatch: () => {},
  moveBatch: () => {},
  runOperation: () => Promise.resolve(null),
  runRecipe: () => Promise.resolve(null),
  markJobsSeen: () => {},
})

export function useJobs(): JobsContextValue {
  return useContext(JobsContext)
}
