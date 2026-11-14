import { useEffect, useState } from "react"

// GET /api/drives/history — see backend analysis/drive_history.py. Times
// arrive as naive local ISO strings and are parsed to ms here, once, so charts
// only ever deal in numbers.

export const HISTORY_RANGES = ["1h", "8h", "24h", "7d", "30d", "90d"] as const
export type HistoryRange = typeof HISTORY_RANGES[number]

type SignalValue = number | boolean | null

interface RawHistory {
  range: HistoryRange
  start: string
  end: string
  bucket_seconds: number
  thresholds: HistoryThresholds
  drives: Record<string, {
    vitals: { t: string[] } & Record<VitalsField, (number | null)[]>
    signals: Record<string, { t: string; value: SignalValue }[]>
    health: { t: string; health_pct: number | null; health_status: string | null }[]
  }>
  jobs: (Omit<HistoryJob, "start" | "end">)[]
}

export type VitalsField = "temp_avg" | "temp_min" | "temp_max" | "read_bps" | "write_bps" | "busy_pct"

export interface HistoryThresholds {
  /** Per signal: the value at or above which it counts as warn / crit. */
  signals: Record<string, { warn_gte: number | null; crit_gte: number | null }>
  health: { healthy_gte: number; degraded_gte: number }
}

/** Vitals per bucket, columnar: t[i] is bucket i's start. Buckets with no
 *  readings are absent, so a gap in t is a gap in the data. */
export type VitalsHistory = { t: number[] } & Record<VitalsField, (number | null)[]>

/** A value holding from t until the next point (or the range end). */
export interface StepPoint<V> { t: number; value: V }

export interface HealthPoint { t: number; pct: number | null; status: string | null }

export interface DriveHistory {
  vitals: VitalsHistory
  signals: Record<string, StepPoint<SignalValue>[]>
  health: HealthPoint[]
}

export interface HistoryJob {
  id: string
  drive_guid: string
  operation: string
  operation_name: string
  category: string
  status: string
  summary: string | null
  error: string | null
  started_at: string
  finished_at: string | null
  /** started_at / finished_at in ms; end is null while the job runs. */
  start: number
  end: number | null
}

export interface DriveHistoryData {
  range: HistoryRange
  start: number
  end: number
  bucketMs: number
  thresholds: HistoryThresholds
  drives: Record<string, DriveHistory>
  jobs: HistoryJob[]
}

const ms = (iso: string) => new Date(iso).getTime()

export function parseHistory(raw: RawHistory): DriveHistoryData {
  const drives: Record<string, DriveHistory> = {}
  for (const [guid, d] of Object.entries(raw.drives)) {
    drives[guid] = {
      vitals: { ...d.vitals, t: d.vitals.t.map(ms) },
      signals: Object.fromEntries(Object.entries(d.signals).map(
        ([name, points]) => [name, points.map(p => ({ t: ms(p.t), value: p.value }))])),
      health: d.health.map(h => ({ t: ms(h.t), pct: h.health_pct, status: h.health_status })),
    }
  }
  return {
    range: raw.range,
    start: ms(raw.start),
    end: ms(raw.end),
    bucketMs: raw.bucket_seconds * 1000,
    thresholds: raw.thresholds,
    drives,
    jobs: raw.jobs.map(j => ({ ...j, start: ms(j.started_at), end: j.finished_at ? ms(j.finished_at) : null })),
  }
}

/** How often a range is refetched: each bucket's width, kept between one and
 *  five minutes — newer buckets only fill in as the collector rolls them up. */
export function refreshMs(range: HistoryRange): number {
  const bucket = { "1h": 60, "8h": 120, "24h": 300, "7d": 1800, "30d": 7200, "90d": 21600 }[range] * 1000
  return Math.min(5 * 60e3, Math.max(60e3, bucket))
}

/**
 * The history of guids over range, refetched on a timer. While a new range or
 * drive set loads, data stays the previous answer and `stale` is true, so
 * charts can dim instead of emptying. Each result is tagged with what it was
 * fetched for (`data.range`; `forGuids`).
 */
export function useDriveHistory(guids: string[], range: HistoryRange) {
  const key = guids.join(",")
  const [state, setState] = useState<{ key: string; range: HistoryRange; data: DriveHistoryData | null; error: string | null }>(
    { key: "", range, data: null, error: null })

  useEffect(() => {
    if (!key) return
    let current = true
    const controller = new AbortController()
    const load = () => {
      fetch(`/api/drives/history?guids=${encodeURIComponent(key)}&range=${range}`, { signal: controller.signal })
        .then(async r => {
          if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
          return r.json()
        })
        .then((raw: RawHistory) => { if (current) setState({ key, range, data: parseHistory(raw), error: null }) })
        .catch((e: unknown) => {
          if (!current || (e instanceof DOMException && e.name === "AbortError")) return
          // A failed refresh keeps what was shown; a failed first load shows nothing.
          setState(s => ({
            key, range,
            data: s.key === key && s.range === range ? s.data : null,
            error: e instanceof Error ? e.message : String(e),
          }))
        })
    }
    load()
    const id = window.setInterval(load, refreshMs(range))
    return () => { current = false; controller.abort(); window.clearInterval(id) }
  }, [key, range])

  if (!key) return { data: null, stale: false, error: null, forGuids: [] as string[] }
  return {
    data: state.data,
    stale: state.key !== key || state.range !== range,
    error: state.key === key && state.range === range ? state.error : null,
    forGuids: state.key ? state.key.split(",") : [],
  }
}
