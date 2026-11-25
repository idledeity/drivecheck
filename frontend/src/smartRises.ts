import type { JobSmart } from "./types"
import { SIGNALS, signalName } from "./signals"

type Comparison = NonNullable<JobSmart["comparison"]>

// What got worse in a SMART comparison (a job's before → after, or a batch's
// span), for a one-line note: "+3 Realloc · +1 Pending". Facts only — a rise
// never fails anything by itself (see recipes/checks.py for the opt-in check).
export type SmartRise = { key: string; short: string; full: string }

export function smartRises(comparison: Comparison | null | undefined): SmartRise[] {
  return (comparison?.worsened ?? []).map(key => {
    if (key === "smart_passed") return { key, short: "SMART failed", full: "SMART status passed → failed" }
    const c = comparison?.changes[key]
    const by = typeof c?.change === "number" ? `+${c.change.toLocaleString()} ` : ""
    const label = SIGNALS[key]?.label ?? signalName(key)
    return { key, short: `${by}${label}`, full: `${signalName(key)} ${c?.before ?? "?"} → ${c?.after ?? "?"}` }
  })
}

// The short note and its hover text, or null when there's nothing to say:
// "SMART not compared" if a counter (or a whole snapshot) couldn't be compared.
export function smartRiseNote(comparison: Comparison | null | undefined, ran: boolean, scope: string): { text: string; title: string; worse: boolean } | null {
  const rises = smartRises(comparison)
  if (rises.length) {
    return { text: rises.map(r => r.short).join(" · "), title: `Got worse during ${scope}: ${rises.map(r => r.full).join(", ")}`, worse: true }
  }
  if (ran && (!comparison || comparison.uncompared.length)) {
    const what = comparison ? comparison.uncompared.map(signalName).join(", ") : "a SMART snapshot is missing"
    return { text: "SMART not compared", title: `Could not compare SMART across ${scope}: ${what}`, worse: false }
  }
  return null
}
