import type { Drive, SelfTestCoverage, SmartDetailResponse } from "./types"
import { formatCapacity, formatDuration, formatTimestamp, jobResultText } from "./format"
import { REPORT_SIGNALS, formatSignal, signalLabel } from "./signals"
import { HEALTH_BAND_TEXT } from "./healthBands"
import { formatPoints } from "./HealthFactors"
import { driveInfoText, type DriveInfo } from "./driveInfo"
import { smartRiseNote } from "./smartRises"
import { batchOutcome, batchState, itemDuration, itemFinishedAt, itemStatus, type TaskItem } from "./taskItems"

/* The Report's words: the verdict paragraph, each DriveCheck task as one
   line, and the whole report as plain text. */

export type ReportData = {
  drive: Drive
  /** The latest full SMART read; null when the drive has none. */
  smart: SmartDetailResponse | null
  info: DriveInfo | null
  /** DriveCheck's finished tests and scans, newest first. */
  tests: TaskItem[]
}

export type TaskSummary = {
  key: string
  name: string
  status: string
  outcome: string
  finishedAt: string
  /** Milliseconds; null when unknown. */
  duration: number | null
  /** What got worse in SMART across it ("+3 Realloc"), if anything. */
  smartNote: string | null
  failed: boolean
}

export function summarizeTask(item: TaskItem): TaskSummary {
  const finishedAt = new Date(itemFinishedAt(item)).toISOString()
  const ms = itemDuration(item)
  const status = itemStatus(item)
  if (item.kind === "job") {
    const note = smartRiseNote(item.job.smart.comparison, item.job.status === "completed", "this task")
    return { key: item.key, name: item.job.operation_name, status, outcome: jobResultText(item.job), finishedAt,
             duration: ms >= 0 ? ms : null, smartNote: note?.worse ? note.text : null, failed: status === "failed" }
  }
  const batch = item.steps[0].batch!
  const note = smartRiseNote(batch.smart, true, "this batch")
  return { key: item.key, name: batch.recipe_name ?? "Batch", status,
           outcome: batchOutcome(batchState(item.steps), batch.stop_on_failure), finishedAt,
           duration: ms >= 0 ? ms : null, smartNote: note?.worse ? note.text : null, failed: status === "failed" }
}

/** A few plain sentences: the verdict, what it rests on, and what testing
 *  there is. Facts and the status's published meaning only. */
export function verdictParagraph(data: ReportData): string {
  const health = data.smart?.health
  const status = health?.health_status ?? null
  const parts: string[] = []
  if (!data.smart) {
    parts.push("There is no full SMART read of this drive yet, so it isn't rated.")
  } else if (!status || health?.health_pct == null) {
    parts.push(`Unrated: ${HEALTH_BAND_TEXT.Unrated}`)
  } else {
    parts.push(`${status} (${health.health_pct}/100). ${HEALTH_BAND_TEXT[status]}`)
    const factors = health.factors ?? []
    const start = factors.find(f => f.role === "start")
    if (start) parts.push(`The score rests on ${lower(start.label)}: ${start.value}.`)
    const others = factors.filter(f => f.role === "adds" && f.points < 0)
    if (others.length) parts.push(`Also lowering it: ${others.map(f => `${lower(f.label)} (${f.value})`).join(", ")}.`)
    if (health.floor != null) parts.push(`Held at ${health.floor}: age, wear and heat alone don't lower it further.`)
  }
  parts.push(selfTestSentence(data.drive.self_test_coverage))
  parts.push(testsSentence(data.tests))
  return parts.join(" ")
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

function selfTestSentence(coverage: SelfTestCoverage): string {
  const long = coverage.latest.long
  const short = coverage.latest.short
  const describe = (name: string, e: NonNullable<typeof long>) => {
    const result = e.drive_report === "ok" ? "passed" : e.drive_report === "marginal" ? "was marginal" : "failed"
    const age = e.age_hours === null ? "" : ` ${e.age_hours.toLocaleString()} power-on hours ago`
    return `its latest ${name} self-test ${result}${age}`
  }
  const bits = [long ? describe("long", long) : "it has no long self-test in its log",
                short ? describe("short", short) : null].filter(Boolean)
  const missing = coverage.log_missing ? " (it has stopped returning its self-test log, so newer results may exist)" : ""
  const sentence = bits.join("; ")
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + missing + "."
}

function testsSentence(tests: TaskItem[]): string {
  if (tests.length === 0) return "DriveCheck hasn't run any tests or scans on it."
  const latest = summarizeTask(tests[0])
  const n = tests.length
  return `DriveCheck has run ${n} test${n === 1 ? "" : "s"} or scan${n === 1 ? "" : "s"} on it; the latest, ${latest.name}, `
    + `finished ${formatTimestamp(latest.finishedAt)}: ${latest.outcome}`
    + `${latest.smartNote ? ` (SMART got worse: ${latest.smartNote})` : ""}.`
}

/** The whole report as plain text: header, verdict, details, health, testing. */
export function buildReportText(data: ReportData): string {
  const { drive, smart, info, tests } = data
  const health = smart?.health
  const passed = smart?.signals?.smart_passed
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
    `Verdict:`,
    ...wrap(verdictParagraph(data), 76).map(l => `  ${l}`),
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
  if (!smart) {
    lines.push(`No full SMART read for this drive yet.`, ``)
  } else {
    lines.push(
      `Full SMART read: ${formatTimestamp(smart.captured_at)}`,
      ``,
      `Health: ${health?.health_pct != null ? `${health.health_pct}/100` : "Unrated"} (${health?.health_status ?? "Unrated"})`,
      ...(health?.factors ?? []).map(f => `  ${f.label}: ${f.value} (${f.role === "start" ? "starts at " : ""}${formatPoints(f)})`),
      ...(health?.floor != null ? [`  Held at ${health.floor}: age, wear and heat alone don't lower it further`] : []),
      `SMART:  ${passed === true ? "Passed" : passed === false ? "Failed" : "—"}`,
      ``,
      `Signals:`,
      ...REPORT_SIGNALS.map(key => {
        const val  = (smart.signals?.[key] ?? null) as number | null
        const flag = smart.signal_flags?.[key]
        const tag  = flag && flag !== "ok" ? ` [${flag.toUpperCase()}]` : ""
        return `  ${signalLabel(key)}: ${formatSignal(key, val)}${tag}`
      }),
      ``,
    )
  }
  const coverage = drive.self_test_coverage
  lines.push(
    `Self-tests (the drive's log):`,
    ...(["short", "conveyance", "long"] as const).map(kind => {
      const e = coverage.latest[kind]
      const name = kind === "long" ? "Long (Extended)" : kind.charAt(0).toUpperCase() + kind.slice(1)
      return `  ${(name + ":").padEnd(17)}${e ? `${e.result}${e.age_hours !== null ? `, ${e.age_hours.toLocaleString()} h ago` : ""}` : "none recorded"}`
    }),
    ``,
    `DriveCheck tests and scans:`,
    ...(tests.length === 0 ? [`  None`] : tests.map(item => {
      const t = summarizeTask(item)
      const ran = t.duration !== null ? `, ran ${formatDuration(t.duration / 1000)}` : ""
      return `  ${formatTimestamp(t.finishedAt)}  ${t.name}: ${t.outcome}${ran}${t.smartNote ? ` [SMART: ${t.smartNote}]` : ""}`
    })),
  )
  return lines.filter(l => l !== null).join("\n")
}

/** Word-wrap to width, for the text file. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}
