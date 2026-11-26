import { useState } from "react"
import type { Drive } from "./types"
import { REPORT_SIGNALS, signalLabel } from "./signals"
import SignalValue from "./SignalValue"
import { DriveChipHeader } from "./DriveChip"
import SmartPanel, { SmartReadLine, SmartSummary } from "./SmartPage"
import { useSmartDetail } from "./smartDetail"
import ReadSmartButton from "./ReadSmartButton"
import { HealthScoreBar } from "./DriveOverview"
import HealthFactors from "./HealthFactors"
import TrendsPanel from "./TrendsPanel"
import { SelfTestCoverageRows } from "./SelfTestLights"
import DriveTestHistory from "./DriveTestHistory"
import "./HealthTab.css"

type SubTab = "analysis" | "smart" | "trends"

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "analysis", label: "Analysis" },
  { id: "smart",    label: "SMART"    },
  { id: "trends",   label: "Trends"   },
]

interface Props {
  drives: Drive[]
  selectedGuids: string[]
}

export default function HealthTab({ drives, selectedGuids }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("analysis")

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
        {subTab === "analysis" && <AnalysisPanel drives={drives} selectedGuids={selectedGuids} onOpenSmart={() => setSubTab("smart")} />}
        {subTab === "smart"    && <SmartPanel drives={drives} selectedGuids={selectedGuids} />}
        {subTab === "trends"   && <TrendsPanel drives={drives} selectedGuids={selectedGuids} />}
      </div>
    </div>
  )
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function AnalysisPanel({ drives, selectedGuids, onOpenSmart }: { drives: Drive[]; selectedGuids: string[]; onOpenSmart: () => void }) {
  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to see their health analysis.</p>
  }
  const selectedDrives = selectedGuids
    .map(g => drives.find(d => d.guid === g))
    .filter(Boolean) as Drive[]
  return (
    <div className="health-multi">
      {selectedDrives.map(drive => (
        <DriveAnalysis key={drive.guid} drive={drive} onOpenSmart={onOpenSmart} />
      ))}
    </div>
  )
}

/* One drive's health analysis: health, signals and SMART values from its
   latest full SMART read, as one point in time (it holds still while read; a
   newer full read offers Refresh, SmartReadLine). Then its self-test coverage
   and what DriveCheck's own tests and scans found. What the drive is lives
   on Info. */
function DriveAnalysis({ drive, onOpenSmart }: { drive: Drive; onOpenSmart: () => void }) {
  const loaded = useSmartDetail(drive.guid)
  const data = loaded.state === "ok" ? loaded.data : null

  return (
    <div className="rep-section">
      <DriveChipHeader drive={drive} />

      {loaded.state === "loading" ? (
        <p className="smart-empty">Loading SMART data…</p>
      ) : !data ? (
        <p className="smart-empty">
          No full SMART read for this drive yet. <ReadSmartButton guids={[drive.guid]} onDone={loaded.reload} />
        </p>
      ) : (
        <>
          <SmartReadLine data={data} drive={drive} onRefresh={loaded.reload} />

          <h4 className="rep-section-title">Health</h4>
          <HealthScoreBar score={data.health?.health_pct ?? null} status={data.health?.health_status ?? null} />
          <HealthFactors factors={data.health?.factors ?? []} floor={data.health?.floor ?? null}
                         scored={data.health?.health_pct != null} />

          <h4 className="rep-section-title">Signals</h4>
          <div className="rep-signals">
            {REPORT_SIGNALS.map(key => (
              <div key={key} className="rep-signal-tile">
                <div className="rep-signal-label">{signalLabel(key)}</div>
                <SignalValue
                  className="rep-signal-value"
                  signal={key}
                  value={(data.signals?.[key] ?? null) as number | null}
                  flag={data.signal_flags?.[key]}
                />
              </div>
            ))}
          </div>

          <h4 className="rep-section-title">SMART values needing attention</h4>
          <SmartSummary data={data} onOpenSmart={onOpenSmart} />
        </>
      )}

      <h4 className="rep-section-title">Self-tests (the drive's log)</h4>
      <div className="rep-selftests">
        <SelfTestCoverageRows coverage={drive.self_test_coverage} />
      </div>

      <h4 className="rep-section-title">DriveCheck tests and scans</h4>
      <DriveTestHistory drive={drive} />
    </div>
  )
}
