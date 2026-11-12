import { useState } from "react"
import type { Drive } from "./types"
import { useJobs } from "./jobsContext"
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
}

// Job state and actions come from App through the jobs context; the sub-tabs
// take them as plain props, which keeps them simple to test.
export default function TasksTab({ drives, selected }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("run")
  const { jobs, unseen, cancelJob, moveJob, runOperation, markJobsSeen } = useJobs()

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
        {subTab === "run"      && <RunTaskTab drives={drives} selected={selected} onRun={runOperation} />}
        {subTab === "activity" && (
          <ActivityTab drives={drives} selectedGuids={selected} jobs={jobs} onCancel={cancelJob} onMove={moveJob}
            unseen={unseen} onMarkSeen={markJobsSeen} onShowHistory={() => setSubTab("history")} />
        )}
        {subTab === "history"  && <HistoryTab drives={drives} selectedGuids={selected} jobs={jobs} onCancel={cancelJob} />}
      </div>
    </div>
  )
}
