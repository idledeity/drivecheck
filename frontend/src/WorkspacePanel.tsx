import { useState } from "react"
import type { Drive } from "./types"
import CollapseToggle from "./CollapseToggle"
import HealthTab from "./HealthTab"
import TasksTab from "./TasksTab"
import { useJobs } from "./jobsContext"
import "./WorkspacePanel.css"

type Tab = "health" | "tasks"

const TABS: { id: Tab; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "tasks",  label: "Tasks"  },
]

interface Props {
  drives: Drive[]
  selected: string[]
}

export default function WorkspacePanel({ drives, selected }: Props) {
  const [tab, setTab]           = useState<Tab>("health")
  // Shown on the Tasks tab too, so it's visible while Tasks is closed.
  const { unseen } = useJobs()
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
            {tab === "tasks"  && <TasksTab drives={drives} selected={selected} />}
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
