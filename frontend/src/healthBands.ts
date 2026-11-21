import type { HealthStatus } from "./types"

// What each health status means and, roughly, how likely a drive in it is to
// fail, from published fleet studies. Ranges, not predictions: the score
// isn't calibrated against failures, and rates vary a lot by model.
//
// Sources:
//   Backblaze Drive Stats 2025 — fleet annualized failure rate 1.36%.
//   Backblaze, "What SMART Stats Tell Us About Hard Drives" (2016) — 23.3% of
//     failed drives had none of the five warning stats above zero.
//   Pinheiro, Weber, Barroso, "Failure Trends in a Large Disk Drive
//     Population" (Google, FAST 2007) — AFR 1.7% in year one up to 8.6% at
//     three years; after the first reallocation 14× the 60-day failure rate
//     and ~85% survive 8 months; after the first scan error 39× and a little
//     over 70% survive 8 months.
export const HEALTH_BAND_TEXT: Record<HealthStatus | "Unrated", string> = {
  Healthy:
    "No sign of trouble. Drives like this fail at roughly 1–2% a year " +
    "(Backblaze fleet, 2025: 1.36%).",
  Aging:
    "No errors, but old or worn. Failure rates climb with age and differ a lot " +
    "by model — roughly 2–9% a year (Google saw 8.6% in 3-year-old drives).",
  Degraded:
    "Sectors replaced or a past failure. After a first reallocated sector " +
    "Google saw 14× the usual 60-day failure rate, and about 15% failed within 8 months.",
  Failing:
    "Unreadable sectors or a failed self-test. After a first scan error " +
    "Google saw 39× the 60-day failure rate, and nearly 30% failed within 8 months. Back it up.",
  Critical:
    "The drive says it's failing, or its errors are severe. Treat its data " +
    "as at risk now and replace it.",
  Unrated:
    "No SMART verdict to score from.",
}

export const HEALTH_SCORE_HOW =
  "The worst problem sets the score; each other one lowers it a little. " +
  "Age and heat alone never go below Aging. About a quarter of failed drives " +
  "give no SMART warning first (Backblaze), so Healthy isn't a guarantee."

export function healthBandText(status: string | null): string {
  const key = (status && status in HEALTH_BAND_TEXT ? status : "Unrated") as keyof typeof HEALTH_BAND_TEXT
  return `${status ?? "Unrated"}: ${HEALTH_BAND_TEXT[key]} ${status ? HEALTH_SCORE_HOW : ""}`.trim()
}

/** Each status's tone class (as the chart bands and chips use them). */
export const HEALTH_CLASS: Record<string, string> = { Healthy: "ok", Aging: "aging", Degraded: "warn", Failing: "crit", Critical: "critical" }
