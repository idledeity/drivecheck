import { useState } from "react"
import type { Drive, Job } from "./types"
import CollapseToggle from "./CollapseToggle"
import HealthTab from "./HealthTab"
import TasksTab from "./TasksTab"
import { useUnseenResults } from "./jobHistory"
import "./WorkspacePanel.css"

type Tab = "health" | "tasks"

const TABS: { id: Tab; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "tasks",  label: "Tasks"  },
]

interface Props {
  drives: Drive[]
  selected: string[]
  jobs: Job[]
  onCancelJob: (jobId: string) => void
  onMoveJob: (jobId: string, direction: "up" | "down") => void
  onRunOperation: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<unknown>
  jobsSeenAt: string | null
  onMarkJobsSeen: () => void
}

export default function WorkspacePanel({ drives, selected, jobs, onCancelJob, onMoveJob, onRunOperation, jobsSeenAt, onMarkJobsSeen }: Props) {
  const [tab, setTab]           = useState<Tab>("health")
  // Here, not in Activity, so the count shows on the Tasks tab while it's closed.
  const unseen = useUnseenResults(jobsSeenAt, jobs)
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="ws-panel">
      <div className="ws-toggle-row">
        <CollapseToggle
          collapsed={!expanded}
          onToggle={() => setExpanded(e => !e)}
          orientation="vertical"
          expandLabel="Expand workspace panel"
          collapseLabel="Collapse workspace panel"
        />
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
                  {t.id === "tasks" && unseen.length > 0 && (
                    <span className="new-count" title={`${unseen.length} finished job${unseen.length === 1 ? "" : "s"} you haven't seen`}>{unseen.length}</span>
                  )}
                </button>
              ))}
            </nav>
          </div>
          <div className="ws-body">
            {tab === "health" && <HealthTab drives={drives} selectedGuids={selected} />}
            {tab === "tasks"  && (
              <TasksTab drives={drives} selected={selected} jobs={jobs} onCancelJob={onCancelJob} onMoveJob={onMoveJob}
                onRunOperation={onRunOperation} unseen={unseen} onMarkJobsSeen={onMarkJobsSeen} />
            )}
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
