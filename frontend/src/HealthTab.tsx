import { useState } from "react"
import type { Drive } from "./types"
import { StubTab } from "./WorkspacePanel"
import SmartAttributesPanel from "./SmartAttributesPanel"
import "./HealthTab.css"

type SubTab = "overview" | "smart" | "report"

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "overview", label: "Overview"        },
  { id: "smart",    label: "SMART attributes" },
  { id: "report",   label: "Report"          },
]

interface Props {
  drives: Drive[]
  selectedGuids: string[]
}

export default function HealthTab({ drives, selectedGuids }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("overview")

  return (
    <div className="health-tab">
      <nav className="health-subtabs">
        {SUBTABS.map(t => (
          <button
            key={t.id}
            className={`health-subtab${subTab === t.id ? " active" : ""}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="health-subtab-body">
        {subTab === "overview" && <StubTab label="Overview" note="Health score · temperature · POH · flagged signals." />}
        {subTab === "smart"    && <SmartAttributesPanel drives={drives} selectedGuids={selectedGuids} />}
        {subTab === "report"   && <StubTab label="Report" note="Identity · verdict · stat tiles · export controls." />}
      </div>
    </div>
  )
}
