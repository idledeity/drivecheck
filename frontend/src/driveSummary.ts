import type { Drive, Job, SelfTestEntry } from "./types"
import { formatCapacity, formatRelativeTime, jobResultText } from "./format"
import { formatSignal, signalName } from "./signals"
import { makeModel } from "./driveCopyText"
import { batchOutcome, batchState, groupTasks, itemFinishedAt } from "./taskItems"

/* Workspace → Summary: one line of facts per drive, shown as a table and
   copied as text or Markdown. Everything comes from /api/drives plus the
   drive's last task, so it's as current as the cards. */

export const SUMMARY_SIGNALS = ["power_on_hours", "reallocated", "pending", "uncorrected", "temp"] as const

export type SelfTestSummary = { text: string; tone: "ok" | "warn" | "crit" | "none" }

export type LastTaskSummary = { name: string; outcome: string; finishedAt: string; failed: boolean }

export type DriveSummary = {
  guid: string
  name: string
  capacity: string | null
  serial: string | null
  device: string
  status: string | null
  score: number | null
  /** The factor the score starts from: the drive's worst problem. */
  worst: { label: string; value: string } | null
  signals: Record<(typeof SUMMARY_SIGNALS)[number], number | null>
  short: SelfTestSummary
  long: SelfTestSummary
  lastTask: LastTaskSummary | null
  smartReadAt: string | null
}

export function summarizeDrive(drive: Drive, lastTask: Job[] = []): DriveSummary {
  const worst = (drive.health_factors ?? []).find(f => f.role === "start") ?? null
  const latest = drive.self_test_coverage?.latest
  return {
    guid: drive.guid,
    name: drive.label ?? makeModel(drive),
    capacity: drive.capacity_bytes ? formatCapacity(drive.capacity_bytes) : null,
    serial: drive.serial,
    device: drive.block_device ?? drive.device,
    status: drive.health_status,
    score: drive.health_pct,
    worst: worst ? { label: worst.label, value: worst.value } : null,
    signals: {
      power_on_hours: drive.power_on_hours,
      reallocated: drive.reallocated,
      pending: drive.pending,
      uncorrected: drive.uncorrected,
      temp: drive.vitals?.temp ?? drive.temp,
    },
    short: selfTest(latest?.short ?? null),
    long: selfTest(latest?.long ?? null),
    lastTask: summarizeLastTask(lastTask),
    smartReadAt: drive.last_polled_at,
  }
}

function selfTest(entry: SelfTestEntry | null): SelfTestSummary {
  if (!entry) return { text: "Never run", tone: "none" }
  const result = entry.drive_report === "ok" ? "Passed" : entry.drive_report === "marginal" ? "Marginal" : "Failed"
  const age = entry.age_hours === null ? "" : ` ${entry.age_hours.toLocaleString()} h ago`
  const tone = entry.drive_report === "ok" ? "ok" : entry.drive_report === "marginal" ? "warn" : "crit"
  return { text: `${result}${age}`, tone }
}

function summarizeLastTask(jobs: Job[]): LastTaskSummary | null {
  const item = jobs.length > 0 ? groupTasks(jobs)[0] : null
  if (!item) return null
  const finishedAt = new Date(itemFinishedAt(item)).toISOString()
  if (item.kind === "job") {
    return { name: item.job.operation_name, outcome: jobResultText(item.job), finishedAt,
             failed: item.job.status === "failed" }
  }
  const state = batchState(item.steps)
  const batch = item.steps[0].batch!
  return { name: batch.recipe_name ?? "Batch", outcome: batchOutcome(state, batch.stop_on_failure), finishedAt,
           failed: state.status === "failed" }
}

const healthText = (s: DriveSummary) => `${s.status ?? "Unrated"}${s.score !== null ? ` ${s.score}/100` : ""}`

const lastTaskText = (t: LastTaskSummary | null) =>
  t ? `${t.name}: ${t.outcome} (${formatRelativeTime(t.finishedAt)})` : "None"

/** Plain text, a short block per drive, for pasting anywhere. */
export function summaryText(rows: DriveSummary[]): string {
  return rows.map(s => [
    [s.name, s.capacity, s.serial ? `S/N ${s.serial}` : null, s.device].filter(Boolean).join(" · "),
    `  Health:     ${healthText(s)}${s.worst ? ` (worst: ${s.worst.label}, ${s.worst.value})` : ""}`,
    `  Signals:    ${SUMMARY_SIGNALS.map(k => `${signalName(k)} ${formatSignal(k, s.signals[k])}`).join(" · ")}`,
    `  Self-tests: Short ${s.short.text.toLowerCase()} · Long ${s.long.text.toLowerCase()}`,
    `  Last task:  ${lastTaskText(s.lastTask)}`,
    s.smartReadAt ? `  SMART read ${formatRelativeTime(s.smartReadAt)}` : `  No SMART read yet`,
  ].join("\n")).join("\n\n")
}

/** A Markdown table, a row per drive, for forums, listings and notes. */
export function summaryMarkdown(rows: DriveSummary[]): string {
  const cell = (v: string | null | undefined) => (v ?? "—").replace(/\|/g, "\\|")
  const head = ["Drive", "Capacity", "Serial", "Health", "Worst factor",
                ...SUMMARY_SIGNALS.map(signalName), "Short test", "Long test", "Last task"]
  const lines = [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => " --- ").join("|")}|`,
    ...rows.map(s => `| ${[
      s.name, s.capacity, s.serial, healthText(s), s.worst ? `${s.worst.label} (${s.worst.value})` : null,
      ...SUMMARY_SIGNALS.map(k => formatSignal(k, s.signals[k])),
      s.short.text, s.long.text, lastTaskText(s.lastTask),
    ].map(cell).join(" | ")} |`),
  ]
  return lines.join("\n")
}
