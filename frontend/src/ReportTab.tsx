import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Drive, SmartDetailResponse } from "./types"
import AsOf from "./AsOf"
import HealthBadge from "./HealthBadge"
import SignalValue from "./SignalValue"
import { HealthScoreBar } from "./DriveOverview"
import HealthFactors from "./HealthFactors"
import { SmartDetailSections, SmartSummary } from "./SmartPage"
import { SelfTestCoverageRows } from "./SelfTestLights"
import { DriveInfoGroups } from "./InfoTab"
import { DriveChipHeader } from "./DriveChip"
import { useSmartDetail } from "./smartDetail"
import { useDriveInfo } from "./driveInfo"
import type { DriveInfo } from "./driveInfo"
import { useDriveTestItems } from "./driveTests"
import { makeModel } from "./driveCopyText"
import { copyText } from "./clipboard"
import { formatDuration, formatTimestamp } from "./format"
import { REPORT_SIGNALS, signalLabel } from "./signals"
import { ExportModeContext, useExportMode } from "./exportMode"
import { buildReportText, summarizeTask, verdictParagraph, type ReportData } from "./reportText"
import "./HealthTab.css"
import "./ReportTab.css"

/* Workspace → Report: each selected drive's full report, for reading here
   (collapsible sections, links between them) or sending out: Print / Save
   as PDF and Download HTML render the same report expanded, light, with
   dates instead of ages; text copies or downloads as plain text. */

type Loaded = { smart: SmartDetailResponse | null; tests: ReportData["tests"] }

export default function ReportTab({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  const info = useDriveInfo(selectedGuids)
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(new Map())
  const [exporting, setExporting] = useState<"print" | "html" | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)

  const onLoaded = useCallback((guid: string, data: Loaded) => {
    setLoaded(prev => new Map(prev).set(guid, data))
  }, [])

  const selected = selectedGuids.map(g => drives.find(d => d.guid === g)).filter((d): d is Drive => !!d)
  const infoFor = (guid: string): DriveInfo | null => (info.state === "ok" ? info.data[guid] ?? null : null)
  const reports: ReportData[] = selected.flatMap(drive => {
    const l = loaded.get(drive.guid)
    return l ? [{ drive, smart: l.smart, tests: l.tests, info: infoFor(drive.guid) }] : []
  })
  const ready = selected.length > 0 && reports.length === selected.length && info.state !== "loading"

  // Once the export copy has rendered: print it, or save it as one HTML file.
  useEffect(() => {
    if (!exporting) return
    const frame = requestAnimationFrame(() => {
      if (exporting === "print") {
        window.print()
      } else if (exportRef.current) {
        download(exportHtml(exportRef.current, selected), "text/html", "html")
      }
      setExporting(null)
    })
    return () => cancelAnimationFrame(frame)
  })

  if (selected.length === 0) return <p className="health-empty">Select one or more drives to see their report.</p>

  const text = () => reports.map(buildReportText).join("\n\n" + "=".repeat(40) + "\n\n")

  return (
    <div className="report-tab">
      <div className="report-toolbar">
        <button className="tinted-btn tinted-btn-sm tint-cy" disabled={!ready} onClick={() => setExporting("print")}>Print / Save as PDF</button>
        <button className="tinted-btn tinted-btn-sm tint-cy" disabled={!ready} onClick={() => setExporting("html")}>Download HTML</button>
        <CopyTextButton disabled={!ready} text={text} />
        <button className="tinted-btn tinted-btn-sm tint-cy" disabled={!ready} onClick={() => download(text(), "text/plain", "txt")}>Download text</button>
      </div>

      {selected.map(drive => (
        <DriveReportLoader key={drive.guid} drive={drive} info={infoFor(drive.guid)} onLoaded={onLoaded} />
      ))}

      {exporting && createPortal(
        <div id="report-export" ref={exportRef}>
          <ExportModeContext.Provider value={true}>
            {reports.map(r => <ReportDoc key={r.drive.guid} data={r} />)}
          </ExportModeContext.Provider>
        </div>,
        document.body,
      )}
    </div>
  )
}

function DriveReportLoader({ drive, info, onLoaded }: {
  drive: Drive
  info: DriveInfo | null
  onLoaded: (guid: string, data: Loaded) => void
}) {
  const smart = useSmartDetail(drive.guid)
  const tests = useDriveTestItems(drive)
  const smartData = smart.state === "ok" ? smart.data : null
  const done = smart.state !== "loading" && tests !== null
  useEffect(() => {
    if (done) onLoaded(drive.guid, { smart: smartData, tests: tests! })
  }, [done, drive.guid, smartData, tests, onLoaded])

  if (!done) return <p className="health-empty">Loading the report for {makeModel(drive)}…</p>
  return <ReportDoc data={{ drive, smart: smartData, tests: tests!, info }} />
}

/** One drive's report. On screen its sections collapse; for export it
 *  renders whole. */
function ReportDoc({ data }: { data: ReportData }) {
  const { drive, smart, info, tests } = data
  const exporting = useExportMode()
  const id = (part: string) => `report-${drive.guid}-${part}`
  const health = smart?.health
  const openAppendix = () => {
    const el = document.getElementById(id("appendix")) as HTMLDetailsElement | null
    if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }) }
  }
  const sections = [
    ["verdict", "Verdict"], ["details", "Drive details"], ["health", "Health"],
    ["testing", "Testing"], ["appendix", "Full SMART read"],
  ] as const

  return (
    <article className="report-doc">
      <header className="report-head">
        <div className="report-kicker">DriveCheck drive report</div>
        <DriveChipHeader drive={drive} className="report-chip" />
        <div className="report-meta">
          <span>S/N {drive.serial ?? "—"}</span>
          {drive.first_seen && <span>First seen {formatTimestamp(drive.first_seen)}</span>}
          {exporting && <span>Report generated {formatTimestamp(new Date().toISOString())}</span>}
        </div>
        {!exporting && (
          <nav className="report-toc">
            {sections.map(([part, title]) => (
              <a key={part} href={`#${id(part)}`} onClick={e => {
                e.preventDefault()
                const el = document.getElementById(id(part)) as HTMLDetailsElement | null
                if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }) }
              }}>{title}</a>
            ))}
          </nav>
        )}
      </header>

      <ReportSection id={id("verdict")} title="Verdict">
        <div className="report-verdict">
          <HealthBadge status={health?.health_status ?? null} score={health?.health_pct ?? null} className="health-badge-lg" />
          <p>{verdictParagraph(data)}</p>
        </div>
      </ReportSection>

      <ReportSection id={id("details")} title="Drive details">
        {info ? <DriveInfoGroups info={info} /> : <p className="smart-empty">Drive details aren't available.</p>}
      </ReportSection>

      <ReportSection id={id("health")} title="Health">
        {!smart ? <p className="smart-empty">No full SMART read for this drive yet.</p> : (
          <>
            <p className="smart-asof">Full SMART read <AsOf at={smart.captured_at} /></p>
            <HealthScoreBar score={health?.health_pct ?? null} status={health?.health_status ?? null} />
            <HealthFactors factors={health?.factors ?? []} floor={health?.floor ?? null} scored={health?.health_pct != null} />
            <h4 className="rep-section-title">Signals</h4>
            <div className="rep-signals">
              {REPORT_SIGNALS.map(key => (
                <div key={key} className="rep-signal-tile">
                  <div className="rep-signal-label">{signalLabel(key)}</div>
                  <SignalValue className="rep-signal-value" signal={key}
                               value={(smart.signals?.[key] ?? null) as number | null} flag={smart.signal_flags?.[key]} />
                </div>
              ))}
            </div>
            <h4 className="rep-section-title">SMART values needing attention</h4>
            <SmartSummary data={smart} onOpenSmart={openAppendix} />
          </>
        )}
      </ReportSection>

      <ReportSection id={id("testing")} title="Testing">
        <h4 className="rep-section-title">Self-tests (the drive's log)</h4>
        <div className="rep-selftests"><SelfTestCoverageRows coverage={drive.self_test_coverage} /></div>
        <h4 className="rep-section-title">DriveCheck tests and scans</h4>
        {tests.length === 0
          ? <p className="smart-empty">DriveCheck hasn't run any tests or scans on this drive.</p>
          : <TestsTable tests={tests} />}
      </ReportSection>

      <ReportSection id={id("appendix")} title="Full SMART read" closed>
        {smart?.detail ? <SmartDetailSections data={smart} /> : <p className="smart-empty">No full SMART read for this drive yet.</p>}
      </ReportSection>
    </article>
  )
}

function ReportSection({ id, title, closed, children }: { id: string; title: string; closed?: boolean; children: ReactNode }) {
  const exporting = useExportMode()
  return (
    <details id={id} className="report-section" open={exporting || !closed}>
      <summary className="report-section-title">{title}</summary>
      <div className="report-section-body">{children}</div>
    </details>
  )
}

const TESTS_SHOWN = 10

/** Every task in an export; on screen the latest 10, then Show all. */
function TestsTable({ tests }: { tests: ReportData["tests"] }) {
  const exporting = useExportMode()
  const [showAll, setShowAll] = useState(false)
  const shown = exporting || showAll ? tests : tests.slice(0, TESTS_SHOWN)
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <thead>
          <tr><th>Finished</th><th>Task</th><th>Result</th><th>Ran</th><th>SMART got worse</th></tr>
        </thead>
        <tbody>
          {shown.map(item => {
            const t = summarizeTask(item)
            return (
              <tr key={t.key}>
                <td className="report-nowrap">{formatTimestamp(t.finishedAt)}</td>
                <td>{t.name}</td>
                <td className={t.failed ? "report-bad" : undefined}>{t.outcome}</td>
                <td className="report-nowrap">{t.duration !== null ? formatDuration(t.duration / 1000) : "—"}</td>
                <td className={t.smartNote ? "report-bad" : "report-dim"}>{t.smartNote ?? "—"}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!exporting && tests.length > TESTS_SHOWN && (
        <button className="report-more-btn" onClick={() => setShowAll(v => !v)}>
          {showAll ? "Show the latest 10" : `Show all ${tests.length}`}
        </button>
      )}
    </div>
  )
}

function CopyTextButton({ text, disabled }: { text: () => string; disabled: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    setState((await copyText(text())) ? "copied" : "failed")
    window.setTimeout(() => setState("idle"), 1500)
  }
  return (
    <button className="tinted-btn tinted-btn-sm tint-cy" disabled={disabled} onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy text"}
    </button>
  )
}

function download(body: string, type: string, ext: string) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = `drivecheck-report-${new Date().toLocaleDateString("sv")}.${ext}`   // local date, YYYY-MM-DD
  a.click()
  URL.revokeObjectURL(url)
}

/** One self-contained HTML file: the export copy's markup with every style
 *  rule the page has, so it looks the same opened anywhere. */
function exportHtml(el: HTMLElement, drives: Drive[]): string {
  const css = [...document.styleSheets].map(sheet => {
    try { return [...sheet.cssRules].map(r => r.cssText).join("\n") } catch { return "" }
  }).join("\n")
  const title = `DriveCheck report — ${drives.map(d => d.serial ?? makeModel(d)).join(", ")}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body class="report-file">
${el.outerHTML}
</body>
</html>
`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
}
