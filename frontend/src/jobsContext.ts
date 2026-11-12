import { createContext, useContext } from "react"
import type { Job } from "./types"

export type JobsContextValue = {
  /** App's live /api/jobs list, polled. */
  jobs: Job[]
  /** Finished jobs since the user last marked results seen, newest first. */
  unseen: Job[]
  cancelJob: (jobId: string) => void
  /** Move a queued job one place earlier or later among its drive's queued jobs. */
  moveJob: (jobId: string, direction: "up" | "down") => void
  /** Queue the operation on each drive; resolves to the server's reason if it refused, else null. */
  runOperation: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<string | null>
  /** Count every job finished so far as seen. */
  markJobsSeen: () => void
}

// The no-op default keeps components usable outside App (tests, previews).
export const JobsContext = createContext<JobsContextValue>({
  jobs: [],
  unseen: [],
  cancelJob: () => {},
  moveJob: () => {},
  runOperation: () => Promise.resolve(null),
  markJobsSeen: () => {},
})

export function useJobs(): JobsContextValue {
  return useContext(JobsContext)
}
