import { useEffect, useState } from "react"
import type { Drive, Job } from "./types"
import { JobRow } from "./QueueTab"
import "./QueueTab.css"
import "./HealthTab.css"

interface Props {
  drives: Drive[]
  selectedGuids: string[]
  onToggleSelect: (guid: string) => void
}

export default function HistoryTab({ drives, selectedGuids, onToggleSelect }: Props) {
  return (
    <div className="queue-tab">
      <div className="drive-switcher">
        {drives.map(d => (
          <button
            key={d.guid}
            className={`drive-chip${selectedGuids.includes(d.guid) ? " active" : ""}`}
            onClick={() => onToggleSelect(d.guid)}
          >
            {d.model ?? d.device}
          </button>
        ))}
      </div>

      {selectedGuids.length === 0 && <p className="smart-empty">Select one or more drives to view job history.</p>}

      {selectedGuids.map(guid => (
        <DriveHistory key={guid} guid={guid} drive={drives.find(d => d.guid === guid)} />
      ))}
    </div>
  )
}

// No-op — history rows are always terminal, so JobRow's cancel button never renders for them.
function noopCancel() {}

function DriveHistory({ guid, drive }: { guid: string; drive: Drive | undefined }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)

  useEffect(() => {
    setJobs(null)
    fetch(`/api/jobs/history?guid=${guid}`)
      .then(r => r.json())
      .then(setJobs)
      .catch(() => setJobs([]))
  }, [guid])

  if (jobs === null) return null

  return (
    <div className="queue-section">
      <div className="queue-section-title">{drive ? (drive.model ?? drive.device) : guid}</div>
      {jobs.length === 0 && <p className="smart-empty">No completed jobs for this drive yet.</p>}
      {jobs.map(job => (
        <JobRow key={job.id} job={job} drive={drive} onCancel={noopCancel} />
      ))}
      <p className="history-note">
        This is DriveCheck's own job log. For self-tests run outside DriveCheck (or that predate it),
        see the drive's native self-test log on the SMART attributes tab.
      </p>
    </div>
  )
}
