import { useState } from "react"
import type { ReactNode } from "react"
import type { Drive } from "./types"
import AsOf from "./AsOf"
import HealthBadge from "./HealthBadge"
import SignalValue from "./SignalValue"
import { DriveChipHeader } from "./DriveChip"
import { copyText } from "./clipboard"
import { formatRelativeTime } from "./format"
import { signalLabel } from "./signals"
import { useJobs } from "./jobsContext"
import { SUMMARY_SIGNALS, summarizeDrive, summaryMarkdown, summaryText } from "./driveSummary"
import type { DriveSummary, SelfTestSummary } from "./driveSummary"
import "./SummaryTab.css"

/* Workspace → Summary: each selected drive's state at a glance, one block
   per drive, stacked; copied as text. */
export default function SummaryTab({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  const { lastTasks } = useJobs()
  const rows = selectedGuids
    .map(g => drives.find(d => d.guid === g))
    .filter((d): d is Drive => !!d)
    .map(d => ({ drive: d, summary: summarizeDrive(d, lastTasks.get(d.guid)) }))

  if (rows.length === 0) return <p className="sum-empty">Select one or more drives to see a summary.</p>

  return (
    <div className="sum-tab">
      <div className="sum-toolbar">
        <CopyButton label="Copy text" text={() => summaryText(rows.map(r => r.summary))} />
      </div>
      {rows.map(({ drive, summary }) => <SummaryBlock key={drive.guid} drive={drive} summary={summary} />)}
    </div>
  )
}

/* Workspace → All Drives: every drive, a row each, to see which need
   attention; selected drives are marked. Copied as a Markdown table. */
export function AllDrivesTab({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  const { lastTasks } = useJobs()
  const rows = drives.map(d => ({ drive: d, summary: summarizeDrive(d, lastTasks.get(d.guid)) }))

  if (rows.length === 0) return <p className="sum-empty">No drives found.</p>

  return (
    <div className="sum-tab">
      <div className="sum-toolbar">
        <CopyButton label="Copy Markdown" text={() => summaryMarkdown(rows.map(r => r.summary))} />
      </div>
      <SummaryTable rows={rows} selected={new Set(selectedGuids)} />
    </div>
  )
}

type Column = { key: string; label: string; cell: (s: DriveSummary, d: Drive) => ReactNode; numeric?: boolean }

const COLUMNS: Column[] = [
  { key: "health", label: "Health", cell: s => (
    <div className="sum-health">
      <HealthBadge status={s.status} score={s.score} />
      {s.worst && <span className="sum-worst" title={`${s.worst.label}: ${s.worst.value}`}>{s.worst.label}: {s.worst.value}</span>}
    </div>
  ) },
  ...SUMMARY_SIGNALS.map((key): Column => ({
    key, label: signalLabel(key), numeric: true,
    cell: (s, d) => <SignalValue signal={key} value={s.signals[key]} flag={d.signal_flags?.[key]} />,
  })),
  { key: "short", label: "Short test", cell: s => <SelfTest t={s.short} /> },
  { key: "long", label: "Long test", cell: s => <SelfTest t={s.long} /> },
  { key: "last", label: "Last task", cell: s => s.lastTask ? (
    <div className="sum-task">
      <span className={s.lastTask.failed ? "sum-crit" : undefined}>{s.lastTask.name}</span>
      <span className="sum-sub" title={s.lastTask.outcome}>{s.lastTask.outcome} · {formatRelativeTime(s.lastTask.finishedAt)}</span>
    </div>
  ) : <span className="sum-sub">None</span> },
  { key: "read", label: "SMART read", cell: (s, d) => s.smartReadAt
    ? <AsOf at={s.smartReadAt} staleAfterS={d.stale_after_s.smart} className="sum-sub" />
    : <span className="sum-sub">Not yet</span> },
]

function SelfTest({ t }: { t: SelfTestSummary }) {
  return <span className={`sum-test sum-test-${t.tone}`}>{t.text}</span>
}

function SummaryTable({ rows, selected }: { rows: { drive: Drive; summary: DriveSummary }[]; selected: Set<string> }) {
  return (
    <div className="sum-table-wrap">
      <table className="sum-table">
        <thead>
          <tr>
            <th scope="col">Drive</th>
            {COLUMNS.map(c => <th key={c.key} scope="col" className={c.numeric ? "sum-num" : undefined}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ drive, summary }) => (
            <tr key={drive.guid} className={selected.has(drive.guid) ? "sum-row-sel" : undefined}
                aria-selected={selected.has(drive.guid)}>
              <th scope="row"><DriveChipHeader drive={drive} /></th>
              {COLUMNS.map(c => <td key={c.key} className={c.numeric ? "sum-num" : undefined}>{c.cell(summary, drive)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SummaryBlock({ drive, summary }: { drive: Drive; summary: DriveSummary }) {
  return (
    <div className="sum-block">
      <DriveChipHeader drive={drive} />
      <dl className="sum-block-list">
        {COLUMNS.map(c => (
          <div key={c.key} className="sum-block-row">
            <dt>{c.label}</dt>
            <dd>{c.cell(summary, drive)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    setState((await copyText(text())) ? "copied" : "failed")
    window.setTimeout(() => setState("idle"), 1500)
  }
  return (
    <button className="tinted-btn tint-cy sum-copy-btn" onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  )
}
