import { useState } from "react"
import type { Drive, Job } from "./types"
import HistoryTab from "./HistoryTab"
import QueueTab from "./QueueTab"
import RunTaskTab from "./RunTaskTab"
import "./TasksTab.css"

type SubTab = "history" | "queue" | "run"

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "run",     label: "Run Task" },
  { id: "queue",   label: "Queue"    },
  { id: "history", label: "History"  },
]

interface Props {
  drives: Drive[]
  selected: string[]
  jobs: Job[]
  onCancelJob: (jobId: string) => void
  onRunOperation: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<unknown>
}

export default function TasksTab({ drives, selected, jobs, onCancelJob, onRunOperation }: Props) {
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
          </button>
        ))}
      </nav>
      <div className="tasks-subtab-body">
        {subTab === "history" && <HistoryTab drives={drives} selectedGuids={selected} />}
        {subTab === "queue"   && <QueueTab drives={drives} jobs={jobs} onCancel={onCancelJob} />}
        {subTab === "run"     && <RunTaskTab drives={drives} selected={selected} onRun={onRunOperation} />}
      </div>
    </div>
  )
}
