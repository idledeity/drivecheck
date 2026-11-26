import { useCallback, useEffect, useRef, useState } from "react"
import type { Drive, SmartDetailResponse } from "./types"
import { REPORT_SIGNALS, formatSignal, signalLabel } from "./signals"
import SignalValue from "./SignalValue"
import { formatCapacity, formatTimestamp } from "./format"
import { DriveChipHeader } from "./DriveChip"
import SmartPanel, { SmartReadLine, SmartSummary } from "./SmartPage"
import { useSmartDetail } from "./smartDetail"
import ReadSmartButton from "./ReadSmartButton"
import { HealthScoreBar } from "./DriveOverview"
import HealthFactors, { formatPoints } from "./HealthFactors"
import TrendsPanel from "./TrendsPanel"
import { SelfTestCoverageRows } from "./SelfTestLights"
import DriveTestHistory from "./DriveTestHistory"
import { driveInfoText, useDriveInfo } from "./driveInfo"
import type { DriveInfo } from "./driveInfo"
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
  // Each drive's full read as shown, so the download matches the page.
  // (The download moves to the Report tab once that exists.)
  const shown = useRef(new Map<string, SmartDetailResponse | null>())
  const onShown = useCallback((guid: string, data: SmartDetailResponse | null) => {
    shown.current.set(guid, data)
  }, [])

  const info = useDriveInfo(selectedGuids)
  const infoFor = (guid: string): DriveInfo | null => (info.state === "ok" ? info.data[guid] ?? null : null)

  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to see their health analysis.</p>
  }

  const selectedDrives = selectedGuids
    .map(g => drives.find(d => d.guid === g))
    .filter(Boolean) as Drive[]

  const handleExport = () => {
    const text = selectedDrives
      .map(d => buildReportText(d, shown.current.get(d.guid) ?? null, infoFor(d.guid)))
      .join("\n\n" + "=".repeat(40) + "\n\n")
    const blob = new Blob([text], { type: "text/plain" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `drivecheck-report-${new Date().toLocaleDateString("sv")}.txt`   // local date, YYYY-MM-DD
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="health-multi">
      <div className="rep-toolbar">
        <button className="rep-export-btn" onClick={handleExport}>Download report</button>
      </div>
      {selectedDrives.map(drive => (
        <DriveAnalysis key={drive.guid} drive={drive} onOpenSmart={onOpenSmart} onShown={onShown} />
      ))}
    </div>
  )
}

/* One drive's health analysis: health, signals and SMART values from its
   latest full SMART read, as one point in time (it holds still while read; a
   newer full read offers Refresh, SmartReadLine). Then its self-test coverage
   and what DriveCheck's own tests and scans found. What the drive is lives
   on Info. */
function DriveAnalysis({ drive, onOpenSmart, onShown }: {
  drive: Drive
  onOpenSmart: () => void
  onShown: (guid: string, data: SmartDetailResponse | null) => void
}) {
  const loaded = useSmartDetail(drive.guid)
  const data = loaded.state === "ok" ? loaded.data : null
  useEffect(() => { onShown(drive.guid, data) }, [drive.guid, data, onShown])

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

function buildReportText(drive: Drive, data: SmartDetailResponse | null, info: DriveInfo | null): string {
  const health   = data?.health
  const passed   = data?.signals?.smart_passed
  const lines: (string | null)[] = [
    `DriveCheck Report`,
    `Generated: ${new Date().toLocaleString()}`,
    ``,
    `Drive:        ${drive.model ?? drive.device}`,
    `Manufacturer: ${drive.manufacturer ?? "—"}`,
    `Serial:       ${drive.serial ?? "—"}`,
    `Type:         ${drive.drive_type ?? "—"}`,
    drive.first_seen ? `First seen:   ${formatTimestamp(drive.first_seen)}` : null,
    ``,
    // The drive's details (identity, media, interface, connection); without
    // them, the basics from the drive list.
    ...(info ? driveInfoText(info) : [
      `Capacity:     ${drive.capacity_bytes ? formatCapacity(drive.capacity_bytes) : "—"}`,
      drive.form_factor ? `Form factor:  ${drive.form_factor}` : null,
      drive.bus         ? `Bus:          ${drive.bus}` : null,
      drive.rpm         ? `RPM:          ${drive.rpm.toLocaleString()}` : null,
      `Device:       ${drive.device}`,
      ``,
    ]),
  ]
  if (!data) {
    lines.push(`No full SMART read for this drive yet.`)
    return lines.filter(l => l !== null).join("\n")
  }
  lines.push(
    `Full SMART read: ${formatTimestamp(data.captured_at)}`,
    ``,
    `Health: ${health?.health_pct != null ? `${health.health_pct}/100` : "Unrated"} (${health?.health_status ?? "Unrated"})`,
    ...(health?.factors ?? []).map(f => `  ${f.label}: ${f.value} (${f.role === "start" ? "starts at " : ""}${formatPoints(f)})`),
    ...(health?.floor != null ? [`  Held at ${health.floor}: age, wear and heat alone don't lower it further`] : []),
    `SMART:  ${passed === true ? "Passed" : passed === false ? "Failed" : "—"}`,
    ``,
    `Signals:`,
    ...REPORT_SIGNALS.map(key => {
      const val  = (data.signals?.[key] ?? null) as number | null
      const flag = data.signal_flags?.[key]
      const tag  = flag && flag !== "ok" ? ` [${flag.toUpperCase()}]` : ""
      return `  ${signalLabel(key)}: ${formatSignal(key, val)}${tag}`
    }),
  )
  return lines.filter(l => l !== null).join("\n")
}
