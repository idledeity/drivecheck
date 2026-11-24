import { memo, useMemo, useState } from "react"
import ChartDriveChip from "./ChartDriveChip"
import { bucketStart } from "./chartGeometry"
import { useChartHover } from "./chartHover"
import { counterFormat } from "./counters"
import { counterEvents } from "./historySeries"
import type { ChartDrive } from "./historySeries"
import { formatCount, momentLabel } from "./scales"
import type { DriveHistoryData } from "./useDriveHistory"
import "./HealthChangeLog.css"
import "./CounterEventLog.css"

/** Under a counter's Events view: every change in the range, newest first —
 *  when, which drive, by how much and to what, and the job it was running.
 *  Collapsed to one line until opened, so the chart stays the card's focus.
 *  A row pins its time on every chart in the group, so the readings under
 *  each show that moment. Also the chart's data in text. */
function CounterEventLog({ data, drives, signal, highlight = null, limit = 10 }: {
  data: DriveHistoryData
  drives: ChartDrive[]
  signal: string
  highlight?: string | null
  /** Rows shown before "Show all". */
  limit?: number
}) {
  const events = useMemo(() => counterEvents(data, drives, signal), [data, drives, signal])
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const { setHover } = useChartHover()
  // Nothing moved: the card's header already says so.
  if (!events.length) return null
  const format = counterFormat(signal)
  const shown = showAll ? events : events.slice(0, limit)
  const many = drives.length > 1
  return (
    <div className="hcl cel">
      <button type="button" className={`cel-toggle${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="hcl-title">{events.length === 1 ? "1 change" : `${formatCount(events.length)} changes`} in range</span>
        <span className="hcl-caret" aria-hidden>›</span>
      </button>
      {open && <>
        <ul className="hcl-list" aria-label="Changes in range">
          {shown.map(ev => (
            <li key={`${ev.drive.guid}-${ev.t}`} className={`hcl-entry${highlight && ev.drive.guid !== highlight ? " dim" : ""}`}>
              <button type="button" className={`cel-main${many ? "" : " one-drive"}`} title="Show the readings at this time on every chart"
                onClick={() => setHover({ t: bucketStart(ev.t, data.start, data.bucketMs), source: "counter-event-log", pinned: true })}>
                <span className="cel-when">{momentLabel(ev.t)}</span>
                {many && <ChartDriveChip drive={ev.drive} />}
                <span className="cel-change"><b>{format.signed(ev.delta)}</b> → {format.value(ev.value)}</span>
                <span className="cel-job">{ev.job ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
        {events.length > limit && (
          <button type="button" className="hcl-more" onClick={() => setShowAll(v => !v)}>
            {showAll ? "Show fewer" : `Show all ${formatCount(events.length)}`}
          </button>
        )}
      </>}
    </div>
  )
}

// Memoized: the panel re-renders on every 2s poll; the list only changes
// with the history data, the drives charted or the highlight.
export default memo(CounterEventLog)
