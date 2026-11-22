import { memo, useMemo, useState } from "react"
import ChartDriveChip from "./ChartDriveChip"
import { counterFormat } from "./counters"
import { counterDriveChanges } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import { momentLabel } from "./scales"
import type { DriveHistoryData } from "./useDriveHistory"
import "./HealthChangeLog.css"
import "./CounterChangeList.css"

/** Under a counter's chart, as the score changes are under the health
 *  chart: which drives' counts moved in the range and by how much, one row
 *  per drive (a busy counter changes on nearly every reading, so a row per
 *  change would be noise). Also the chart's data in text. */
function CounterChangeList({ data, drives, signal, limit = 5 }: {
  data: DriveHistoryData
  drives: ChartDrive[]
  signal: string
  /** Rows shown before "Show all". */
  limit?: number
}) {
  const rows = useMemo(() => counterDriveChanges(data, drives, signal), [data, drives, signal])
  const [showAll, setShowAll] = useState(false)
  // Nothing moved: the card's header already says so.
  if (!rows.length) return null
  const { value } = counterFormat(signal)
  const signed = (d: number) => `${d > 0 ? "+" : "−"}${value(Math.abs(d))}`
  const shown = showAll ? rows : rows.slice(0, limit)
  return (
    <div className="hcl">
      <div className="hcl-head">
        <h4 className="hcl-title">Changes in range</h4>
        <span className="hcl-note">Biggest first</span>
      </div>
      <ul className="hcl-list" aria-label="Changes in range">
        {shown.map(r => (
          <li key={r.drive.guid} className="hcl-entry ccl-row">
            <ChartDriveChip drive={r.drive} />
            <span className="ccl-values">
              {r.to !== r.from
                ? <>{value(r.from)} → {value(r.to)} <b>{signed(r.to - r.from)}</b></>
                : <b>{value(r.to)}</b>}
              {r.firstRead !== null && (
                <span className="hcl-first" title="The first value read for this drive: not a change in the drive">
                  <span aria-hidden>◇</span> first read {momentLabel(r.firstRead)}
                </span>
              )}
            </span>
            <span className="ccl-when">
              {r.lastChange !== null
                ? <>{r.changes === 1 ? "once" : `${r.changes.toLocaleString()} changes`}, last {momentLabel(r.lastChange)}</>
                : "no change since"}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button type="button" className="hcl-more" onClick={() => setShowAll(v => !v)}>
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

// Memoized: the panel re-renders on every 2s poll; the list only changes
// with the history data or the drives charted.
export default memo(CounterChangeList)
