import { useState } from "react"
import type { Drive, Job } from "./types"
import ActivityTab from "./ActivityTab"
import HistoryTab from "./HistoryTab"
import RunTaskTab from "./RunTaskTab"
import "./TasksTab.css"

type SubTab = "run" | "activity" | "history"

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "run",      label: "Run Task" },
  { id: "activity", label: "Activity" },
  { id: "history",  label: "History"  },
]

interface Props {
  drives: Drive[]
  selected: string[]
  jobs: Job[]
  onCancelJob: (jobId: string) => void
  onMoveJob: (jobId: string, direction: "up" | "down") => void
  onRunOperation: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<unknown>
  unseen: Job[]   // finished jobs since the user last marked results seen, newest first
  onMarkJobsSeen: () => void
}

export default function TasksTab({ drives, selected, jobs, onCancelJob, onMoveJob, onRunOperation, unseen, onMarkJobsSeen }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("run")

  return (
    <div className="tasks-tab">
      <nav className="tasks-subtabs">
        {SUBTABS.map(t => (
          <button
            key={t.id}
            className={`tasks-subtab${subTab === t.id ? " active" : ""}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
            {t.id === "activity" && unseen.length > 0 && <span className="new-count">{unseen.length}</span>}
          </button>
        ))}
      </nav>
      <div className="tasks-subtab-body">
        {subTab === "run"      && <RunTaskTab drives={drives} selected={selected} onRun={onRunOperation} />}
        {subTab === "activity" && (
          <ActivityTab drives={drives} selectedGuids={selected} jobs={jobs} onCancel={onCancelJob} onMove={onMoveJob}
            unseen={unseen} onMarkSeen={onMarkJobsSeen} onShowHistory={() => setSubTab("history")} />
        )}
        {subTab === "history"  && <HistoryTab drives={drives} selectedGuids={selected} jobs={jobs} onCancel={onCancelJob} />}
      </div>
    </div>
  )
}
