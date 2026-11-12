import { useEffect, useMemo, useState } from "react"
import type { Job } from "./types"

// A drive's stored job history (fetched once) overlaid with App's live job
// list: a job in both shows its live version, and a live job not yet stored is
// added. Live state is current the moment a job changes — its stored row is
// only rewritten after the "after" SMART snapshot, so re-fetching on a status
// change would race that write. Newest first.
export function mergeHistory(stored: Job[], live: Job[]): Job[] {
  const liveById = new Map(live.map(j => [j.id, j]))
  const storedIds = new Set(stored.map(j => j.id))
  return [...stored.map(j => liveById.get(j.id) ?? j), ...live.filter(j => !storedIds.has(j.id))]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export const FINISHED_STATUSES = new Set<Job["status"]>(["completed", "failed", "cancelled", "interrupted"])

const finishedTime = (j: Job) => (j.finished_at ? new Date(j.finished_at).getTime() : NaN)

// Finished jobs the user hasn't seen: everything that finished after seenAt
// (a local ISO time), from stored history plus App's live job list so a job
// counts the moment it finishes. Newest first; empty until seenAt is known.
export function useUnseenResults(seenAt: string | null, liveJobs: Job[]): Job[] {
  const [stored, setStored] = useState<{ seenAt: string; jobs: Job[] } | null>(null)

  useEffect(() => {
    if (seenAt === null) return
    let current = true
    fetch(`/api/jobs/history?limit=500&since=${encodeURIComponent(seenAt)}`)
      .then(r => r.json())
      .then((rows: Job[]) => { if (current) setStored({ seenAt, jobs: Array.isArray(rows) ? rows : [] }) })
      .catch(() => { if (current) setStored({ seenAt, jobs: [] }) })
    return () => { current = false }
  }, [seenAt])

  return useMemo(() => {
    if (seenAt === null) return []
    const since = new Date(seenAt).getTime()
    const rows = stored?.seenAt === seenAt ? stored.jobs : []
    return mergeHistory(rows, liveJobs)
      .filter(j => FINISHED_STATUSES.has(j.status) && finishedTime(j) > since)
      .sort((a, b) => finishedTime(b) - finishedTime(a))
  }, [seenAt, stored, liveJobs])
}
