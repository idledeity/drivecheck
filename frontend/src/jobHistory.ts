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
