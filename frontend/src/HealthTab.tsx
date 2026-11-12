import { useState } from "react"
import type { Drive } from "./types"
import { REPORT_SIGNALS, formatSignal, signalLabel } from "./signals"
import SignalValue from "./SignalValue"
import { formatCapacity, formatTimestamp } from "./format"
import { DriveChipHeader } from "./DriveChip"
import { DriveAttributes } from "./SmartAttributesPanel"
import "./HealthTab.css"

type SubTab = "overview" | "report"

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "report",   label: "Report"   },
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
        {subTab === "overview" && <OverviewPanel drives={drives} selectedGuids={selectedGuids} />}
        {subTab === "report"   && <ReportPanel drives={drives} selectedGuids={selectedGuids} />}
      </div>
    </div>
  )
}

// ── Score helpers ─────────────────────────────────────────────────────────────

function scoreColorCls(status: string | null): string {
  if (status === "Healthy")  return "score-ok"
  if (status === "Degraded") return "score-warn"
  if (status === "Failing")  return "score-fail"
  return "score-unrated"
}

// ── Overview ──────────────────────────────────────────────────────────────────

function OverviewPanel({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to view an overview.</p>
  }
  return (
    <div className="health-multi">
      {selectedGuids.map(guid => {
        const drive = drives.find(d => d.guid === guid)
        return drive ? <DriveOverview key={guid} drive={drive} /> : null
      })}
    </div>
  )
}

function DriveOverview({ drive }: { drive: Drive }) {
  const score    = drive.health_pct
  const status   = drive.health_status
  const colorCls = scoreColorCls(status)
  const liveTemp = drive.vitals.temp ?? drive.temp

  const flagged = Object.entries(drive.signal_flags ?? {})
    .filter(([key, sev]) => REPORT_SIGNALS.includes(key) && (sev === "warn" || sev === "crit"))
    .sort(([, a], [, b]) => (a === "crit" ? -1 : b === "crit" ? 1 : 0))

  return (
    <div className="hov-section">
      <DriveChipHeader drive={drive} />

      <div className="hov-score-row">
        <div className="hov-score-track">
          <div
            className={`hov-score-fill ${colorCls}`}
            style={{ width: score !== null ? `${score}%` : "0%" }}
          />
        </div>
        <span className={`hov-score-num ${colorCls}`}>{score ?? "—"}</span>
        <span className={`hov-score-label ${colorCls}`}>{status ?? "Unrated"}</span>
      </div>

      <div className="hov-stats">
        <HealthStat drive={drive} signal="temp" value={liveTemp} />
        <HealthStat drive={drive} signal="power_on_hours" value={drive.power_on_hours} />
      </div>

      {flagged.length > 0 ? (
        <div className="hov-flags">
          {flagged.map(([key, sev]) => (
            <span key={key} className={`hov-flag-chip ${sev}`}>
              {signalLabel(key)}: {formatSignal(key, drive[key as keyof Drive] as number | null)}
            </span>
          ))}
        </div>
      ) : score !== null ? (
        <p className="hov-no-flags">No flagged signals</p>
      ) : null}
    </div>
  )
}

function HealthStat({ drive, signal, value }: { drive: Drive; signal: string; value: number | null }) {
  return (
    <div className="hov-stat">
      <div className="hov-stat-label">{signalLabel(signal)}</div>
      <SignalValue className="hov-stat-value" signal={signal} value={value} flag={drive.signal_flags?.[signal]} />
    </div>
  )
}

// ── Report ────────────────────────────────────────────────────────────────────

function ReportPanel({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to view a report.</p>
  }

  const selectedDrives = selectedGuids
    .map(g => drives.find(d => d.guid === g))
    .filter(Boolean) as Drive[]

  const handleExport = () => {
    const text = selectedDrives.map(buildReportText).join("\n\n" + "=".repeat(40) + "\n\n")
    const blob = new Blob([text], { type: "text/plain" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `drivecheck-report-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="health-multi">
      <div className="rep-toolbar">
        <button className="rep-export-btn" onClick={handleExport}>Download report</button>
      </div>
      {selectedDrives.map(drive => (
        <DriveReport key={drive.guid} drive={drive} />
      ))}
    </div>
  )
}

function DriveReport({ drive }: { drive: Drive }) {
  const score    = drive.health_pct
  const status   = drive.health_status
  const colorCls = scoreColorCls(status)
  const liveTemp = drive.vitals.temp ?? drive.temp

  return (
    <div className="rep-section">
      <DriveChipHeader drive={drive} />

      <div className="rep-identity-grid">
        <RepRow label="Type"     value={drive.drive_type ?? "—"} />
        <RepRow label="Capacity" value={drive.capacity_bytes ? formatCapacity(drive.capacity_bytes) : "—"} />
        {drive.form_factor && <RepRow label="Form factor" value={drive.form_factor} />}
        {drive.bus         && <RepRow label="Bus"         value={drive.bus} />}
        {drive.rpm         && <RepRow label="RPM"         value={drive.rpm.toLocaleString()} />}
        <RepRow label="Device" value={drive.device} />
        {drive.first_seen     && <RepRow label="First seen"  value={formatTimestamp(drive.first_seen)} />}
        {drive.last_polled_at && <RepRow label="Last polled" value={formatTimestamp(drive.last_polled_at)} />}
      </div>

      <h4 className="rep-section-title">Health</h4>
      <div className="hov-score-row">
        <div className="hov-score-track">
          <div
            className={`hov-score-fill ${colorCls}`}
            style={{ width: score !== null ? `${score}%` : "0%" }}
          />
        </div>
        <span className={`hov-score-num ${colorCls}`}>{score ?? "—"}</span>
        <span className={`hov-score-label ${colorCls}`}>{status ?? "Unrated"}</span>
      </div>

      <h4 className="rep-section-title">Signals</h4>
      <div className="rep-signals">
        {REPORT_SIGNALS.map(key => (
          <div key={key} className="rep-signal-tile">
            <div className="rep-signal-label">{signalLabel(key)}</div>
            <SignalValue
              className="rep-signal-value"
              signal={key}
              value={key === "temp" ? liveTemp : drive[key as keyof Drive] as number | null}
              flag={drive.signal_flags?.[key]}
            />
          </div>
        ))}
      </div>

      <h4 className="rep-section-title">SMART attributes</h4>
      <DriveAttributes guid={drive.guid} />
    </div>
  )
}

function RepRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rep-row">
      <span className="rep-row-label">{label}</span>
      <span className="rep-row-value">{value}</span>
    </div>
  )
}

function buildReportText(drive: Drive): string {
  const score    = drive.health_pct
  const liveTemp = drive.vitals.temp ?? drive.temp
  const lines: (string | null)[] = [
    `DriveCheck Report`,
    `Generated: ${new Date().toLocaleString()}`,
    ``,
    `Drive:        ${drive.model ?? drive.device}`,
    `Manufacturer: ${drive.manufacturer ?? "—"}`,
    `Serial:       ${drive.serial ?? "—"}`,
    `Capacity:     ${drive.capacity_bytes ? formatCapacity(drive.capacity_bytes) : "—"}`,
    `Type:         ${drive.drive_type ?? "—"}`,
    drive.form_factor ? `Form factor:  ${drive.form_factor}` : null,
    drive.bus         ? `Bus:          ${drive.bus}` : null,
    drive.rpm         ? `RPM:          ${drive.rpm.toLocaleString()}` : null,
    `Device:       ${drive.device}`,
    drive.first_seen     ? `First seen:   ${formatTimestamp(drive.first_seen)}`     : null,
    drive.last_polled_at ? `Last polled:  ${formatTimestamp(drive.last_polled_at)}` : null,
    ``,
    `Health: ${score !== null ? `${score}/100` : "Unrated"} (${drive.health_status ?? "Unrated"})`,
    `SMART:  ${drive.smart_passed === true ? "Passed" : drive.smart_passed === false ? "Failed" : "—"}`,
    ``,
    `Signals:`,
    ...REPORT_SIGNALS.map(key => {
      const val  = key === "temp" ? liveTemp : drive[key as keyof Drive] as number | null
      const flag = drive.signal_flags?.[key]
      const tag  = flag && flag !== "ok" ? ` [${flag.toUpperCase()}]` : ""
      return `  ${signalLabel(key)}: ${formatSignal(key, val)}${tag}`
    }),
  ]
  return lines.filter(l => l !== null).join("\n")
}
