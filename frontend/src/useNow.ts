import { useEffect, useState } from "react"

// Ages are shown to the minute, so a 30s clock is never visibly behind.
const TICK_MS = 30_000

/** The current time (ms), re-rendering the caller every 30 seconds: for ages
 *  and staleness that must keep counting while a view sits open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/** Whether a reading taken at `at` (ISO) is older than `staleAfterS` seconds. */
export function isStale(at: string | null | undefined, staleAfterS: number | undefined, now: number): boolean {
  if (!at || staleAfterS === undefined) return false
  return now - new Date(at).getTime() > staleAfterS * 1000
}
