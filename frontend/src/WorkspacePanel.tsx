import { useState } from "react"
import { IconX } from "@tabler/icons-react"
import type { Drive } from "./types"
import "./WorkspacePanel.css"

type Tab = "health" | "history" | "queue" | "tasks"

const TABS: { id: Tab; label: string }[] = [
  { id: "health",  label: "Health"   },
  { id: "history", label: "History"  },
  { id: "queue",   label: "Queue"    },
  { id: "tasks",   label: "Run Task" },
]

interface Props {
  drive: Drive
  onClose: () => void
}

export default function WorkspacePanel({ drive, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("health")

  return (
    <div className="ws-panel">
      <div className="ws-header">
        <div className="ws-identity">
          <span className="ws-name">{drive.model ?? drive.device}</span>
          {drive.serial && <span className="ws-serial">{drive.serial}</span>}
        </div>
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
        <button className="ws-close" onClick={onClose} title="Close panel">
          <IconX size={14} />
        </button>
      </div>
      <div className="ws-body">
        {tab === "health"  && <StubTab label="Health"   note="Overview · SMART attributes · Report" />}
        {tab === "history" && <StubTab label="History"  note="Past job executions for this drive." />}
        {tab === "queue"   && <StubTab label="Queue"    note="Running and queued jobs across all drives." />}
        {tab === "tasks"   && <StubTab label="Run Task" note="Configure and launch operations on this drive." />}
      </div>
    </div>
  )
}

function StubTab({ label, note }: { label: string; note: string }) {
  return (
    <div className="ws-stub">
      <span className="ws-stub-label">{label}</span>
      <span className="ws-stub-note">{note}</span>
    </div>
  )
}
