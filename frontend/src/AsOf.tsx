import { useEffect, useState } from "react"
import { formatRelativeTime, formatTimestamp } from "./format"

// How often the relative age is redrawn; its coarsest unit below an hour is a minute.
const TICK_MS = 30_000

/**
 * When a value was read, as its age ("12m ago"), with the exact time on hover.
 * Keeps itself current while the view sits open, so a value that stopped
 * updating visibly gets older rather than reading as fresh.
 */
export default function AsOf({ at, prefix, className }: { at: string; prefix?: string; className?: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  return (
    <time className={className} dateTime={at} title={formatTimestamp(at)}>
      {prefix && <>{prefix} </>}{formatRelativeTime(at)}
    </time>
  )
}
