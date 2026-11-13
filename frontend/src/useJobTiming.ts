import { useEffect, useState } from "react"
import type { Job } from "./types"
import { formatDuration } from "./format"

/**
 * How long a running job has been going and how long it has left, kept live:
 * ticks once a second while the job runs, since polled job data only changes
 * every few seconds at best. Everything is null when the job isn't running.
 *
 * `text` is the "4m 10s · 12m 33s left" line both the drive card and job
 * rows show ("—" for the remaining part while there's no estimate yet).
 */
export function useJobTiming(job: Job | undefined) {
  const running = job?.status === "running"
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  const elapsedSeconds = running && job.started_at
    ? (now - new Date(job.started_at).getTime()) / 1000
    : null
  // The backend already fills this in (operation's own estimate, or a
  // percent/elapsed extrapolation) — see JobRegistry.get_progress().
  const remainingSeconds = running ? job.progress.eta_seconds ?? null : null
  const text = elapsedSeconds !== null
    ? `${formatDuration(elapsedSeconds)} · ${remainingSeconds !== null ? `${formatDuration(remainingSeconds)} left` : "—"}`
    : null

  return { elapsedSeconds, remainingSeconds, text }
}
