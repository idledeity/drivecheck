import { formatRelativeTime, formatTimestamp } from "./format"
import { isStale, useNow } from "./useNow"
import "./AsOf.css"

/**
 * When a value was read, as its age ("12m ago"), with the exact time on hover.
 * Keeps itself current while the view sits open, so a value that stopped
 * updating visibly gets older rather than reading as fresh. Past
 * `staleAfterS` seconds it turns amber: the reading is overdue.
 */
export default function AsOf({ at, prefix, staleAfterS, className }: {
  at: string
  prefix?: string
  staleAfterS?: number
  className?: string
}) {
  const now = useNow()
  const stale = isStale(at, staleAfterS, now)
  const title = stale ? `Overdue: last read ${formatTimestamp(at)}` : formatTimestamp(at)
  return (
    <time className={`asof${stale ? " asof-stale" : ""}${className ? ` ${className}` : ""}`} dateTime={at} title={title}>
      {prefix && <>{prefix} </>}{formatRelativeTime(at)}
    </time>
  )
}
