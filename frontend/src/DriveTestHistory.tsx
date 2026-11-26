import { useEffect, useMemo, useState } from "react"
import type { Drive, Job } from "./types"
import { TaskRow } from "./BatchRow"
import { useJobs } from "./jobsContext"
import { FINISHED_STATUSES, mergeHistory } from "./jobHistory"
import { groupTasks } from "./taskItems"

/* Health › Analysis: what DriveCheck's own tests and scans on one drive
   found — finished Test and Scan tasks (a batch as one row), newest first.
   Debug and Maintenance (wipes) aren't evidence about the drive's health. */

const EXCLUDED = ["Debug", "Maintenance"]
const FETCH_LIMIT = 100
const SHOWN = 5

export default function DriveTestHistory({ drive }: { drive: Drive }) {
  const { jobs: live, cancelJob, cancelBatch } = useJobs()
  const [stored, setStored] = useState<{ guid: string; jobs: Job[] } | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let current = true
    fetch(`/api/jobs/history?guid=${encodeURIComponent(drive.guid)}&limit=${FETCH_LIMIT}`
          + `&exclude_category=${EXCLUDED.join(",")}`)
      .then(r => r.json())
      .then((rows: Job[]) => { if (current) setStored({ guid: drive.guid, jobs: Array.isArray(rows) ? rows : [] }) })
      .catch(() => { if (current) setStored({ guid: drive.guid, jobs: [] }) })
    return () => { current = false }
  }, [drive.guid])

  const items = useMemo(() => {
    const mine = live.filter(j => j.drive_guid === drive.guid && !EXCLUDED.includes(j.category))
    const finished = mergeHistory(stored?.guid === drive.guid ? stored.jobs : [], mine)
      .filter(j => FINISHED_STATUSES.has(j.status))
    return groupTasks(finished)
  }, [stored, live, drive.guid])

  if (stored?.guid !== drive.guid) return <p className="smart-empty">Loading…</p>
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
