import { useEffect, useMemo, useState } from "react"
import type { Drive, Job } from "./types"
import { useJobs } from "./jobsContext"
import { FINISHED_STATUSES, mergeHistory } from "./jobHistory"
import { groupTasks, type TaskItem } from "./taskItems"

/* What DriveCheck's own tests and scans on one drive found: its finished
   Test and Scan tasks (a batch as one item), newest first, from stored
   history merged with the live list. Debug and Maintenance (wipes) aren't
   evidence about the drive's health. Health › Analysis and the Report. */

export const EXCLUDED_CATEGORIES = ["Debug", "Maintenance"]
const FETCH_LIMIT = 100

/** null until the stored history has loaded. */
export function useDriveTestItems(drive: Drive): TaskItem[] | null {
  const { jobs: live } = useJobs()
  const [stored, setStored] = useState<{ guid: string; jobs: Job[] } | null>(null)

  useEffect(() => {
    let current = true
    fetch(`/api/jobs/history?guid=${encodeURIComponent(drive.guid)}&limit=${FETCH_LIMIT}`
          + `&exclude_category=${EXCLUDED_CATEGORIES.join(",")}`)
      .then(r => r.json())
      .then((rows: Job[]) => { if (current) setStored({ guid: drive.guid, jobs: Array.isArray(rows) ? rows : [] }) })
      .catch(() => { if (current) setStored({ guid: drive.guid, jobs: [] }) })
    return () => { current = false }
  }, [drive.guid])

  return useMemo(() => {
    if (stored?.guid !== drive.guid) return null
    const mine = live.filter(j => j.drive_guid === drive.guid && !EXCLUDED_CATEGORIES.includes(j.category))
    return groupTasks(mergeHistory(stored.jobs, mine).filter(j => FINISHED_STATUSES.has(j.status)))
  }, [stored, live, drive.guid])
}
