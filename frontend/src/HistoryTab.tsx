import { useEffect, useMemo, useState } from "react"
import type { Drive, Job } from "./types"
import { mergeHistory } from "./jobHistory"
import { JobRow } from "./QueueTab"
import DriveIdentity from "./DriveIdentity"
import "./QueueTab.css"
import "./HealthTab.css"

interface Props {
  drives: Drive[]
  selectedGuids: string[]
  jobs: Job[]  // App's live /api/jobs list (this session's jobs, polled)
  onCancel: (jobId: string) => void
}

export default function HistoryTab({ drives, selectedGuids, jobs, onCancel }: Props) {
  return (
    <div className="queue-tab">
      {selectedGuids.length === 0 && <p className="smart-empty">Select one or more drives to view job history.</p>}

      {selectedGuids.map(guid => (
        <DriveHistory key={guid} guid={guid} drive={drives.find(d => d.guid === guid)} liveJobs={jobs} onCancel={onCancel} />
      ))}
    </div>
  )
}

function DriveHistory({ guid, drive, liveJobs, onCancel }: {
  guid: string
  drive: Drive | undefined
  liveJobs: Job[]
  onCancel: (jobId: string) => void
}) {
  const [stored, setStored] = useState<Job[] | null>(null)

  // Keyed by guid in HistoryTab, so another drive remounts this with stored = null.
  useEffect(() => {
    fetch(`/api/jobs/history?guid=${guid}`)
      .then(r => r.json())
      .then(setStored)
      .catch(() => setStored([]))
  }, [guid])

  const jobs = useMemo(
    () => stored && mergeHistory(stored, liveJobs.filter(j => j.drive_guid === guid)),
    [stored, liveJobs, guid],
  )

  if (jobs === null) return null

  return (
    <div className="queue-section">
      <DriveIdentity drive={drive} className="history-drive-header" />
      {jobs.length === 0 && <p className="smart-empty">No completed jobs for this drive yet.</p>}
      {jobs.map(job => (
        <JobRow key={job.id} job={job} drive={drive} onCancel={onCancel} />
      ))}
      <p className="history-note">
        This is DriveCheck's own job log. For self-tests run outside DriveCheck (or that predate it),
        see the drive's native self-test log on the SMART attributes tab.
      </p>
    </div>
  )
}
