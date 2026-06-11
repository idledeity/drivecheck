import { useState } from "react"
import { IconChevronUp, IconChevronDown } from "@tabler/icons-react"
import type { Drive } from "./types"
import HealthTab from "./HealthTab"
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
  onToggleSelect: (guid: string) => void
}

export default function WorkspacePanel({ drives, selected, onToggleSelect }: Props) {
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
            {tab === "health"  && <HealthTab drives={drives} selectedGuids={selected} onToggleSelect={onToggleSelect} />}
            {tab === "history" && <StubTab label="History"  note="Past job executions for this drive." />}
            {tab === "queue"   && <StubTab label="Queue"    note="Running and queued jobs across all drives." />}
            {tab === "tasks"   && <StubTab label="Run Task" note="Configure and launch operations on this drive." />}
          </div>
        </>
      )}
    </div>
  )
}

export function StubTab({ label, note }: { label: string; note: string }) {
  return (
    <div className="ws-stub">
      <span className="ws-stub-label">{label}</span>
      <span className="ws-stub-note">{note}</span>
    </div>
  )
}
