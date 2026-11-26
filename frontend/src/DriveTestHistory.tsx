import { useState } from "react"
import type { Drive } from "./types"
import { TaskRow } from "./BatchRow"
import { useJobs } from "./jobsContext"
import { useDriveTestItems } from "./driveTests"

const SHOWN = 5

/* Health › Analysis: DriveCheck's finished tests and scans on one drive, as
   the task rows Tasks › History shows; 5, then Show all. */
export default function DriveTestHistory({ drive }: { drive: Drive }) {
  const { cancelJob, cancelBatch } = useJobs()
  const items = useDriveTestItems(drive)
  const [showAll, setShowAll] = useState(false)

  if (items === null) return <p className="smart-empty">Loading…</p>
  if (items.length === 0) {
    return <p className="smart-empty">DriveCheck hasn't run any tests or scans on this drive.</p>
  }
  const visible = showAll ? items : items.slice(0, SHOWN)
  return (
    <div className="dth-list">
      {visible.map(item => (
        <TaskRow key={item.key} item={item} drive={drive} onCancel={cancelJob} onCancelBatch={cancelBatch} compact />
      ))}
      {items.length > SHOWN && (
        <button className="rep-more-btn" onClick={() => setShowAll(v => !v)}>
          {showAll ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  )
}
