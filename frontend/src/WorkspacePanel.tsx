import { useState } from "react"
import { IconChevronUp, IconChevronDown } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import HealthTab from "./HealthTab"
import HistoryTab from "./HistoryTab"
import QueueTab from "./QueueTab"
import RunTaskTab from "./RunTaskTab"
import "./WorkspacePanel.css"

type Tab = "health" | "history" | "queue" | "tasks"

const TABS: { id: Tab; label: string }[] = [
  { id: "health",  label: "Health"   },
  { id: "history", label: "History"  },
  { id: "queue",   label: "Queue"    },
  { id: "tasks",   label: "Run Task" },
]

interface Props {
  drives: Drive[]
  selected: string[]
  jobs: Job[]
  onCancelJob: (jobId: string) => void
  onRunOperation: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<unknown>
}

export default function WorkspacePanel({ drives, selected, jobs, onCancelJob, onRunOperation }: Props) {
  const [tab, setTab]           = useState<Tab>("health")
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="ws-panel">
      <div className="ws-toggle-row">
        <button className="ws-toggle" onClick={() => setExpanded(e => !e)}>
          {expanded ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
        </button>
      </div>
      {expanded && (
        <>
          <div className="ws-header">
            <nav className="ws-tabs">
              {TABS.map(t => (
                <button
                  key={t.id}
                  className={`ws-tab${tab === t.id ? " active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="ws-body">
            {tab === "health"  && <HealthTab drives={drives} selectedGuids={selected} />}
            {tab === "history" && <HistoryTab drives={drives} selectedGuids={selected} />}
            {tab === "queue"   && <QueueTab drives={drives} jobs={jobs} onCancel={onCancelJob} />}
            {tab === "tasks"   && <RunTaskTab drives={drives} selected={selected} onRun={onRunOperation} />}
          </div>
        </>
      )}
    </div>
  )
}

export function StubTab({ label, note }: { label: string; note: string }) {
  return (
    <div className="ws-stub">
      <h2 className="ws-stub-label">{label}</h2>
      <span className="ws-stub-note">{note}</span>
    </div>
  )
}
