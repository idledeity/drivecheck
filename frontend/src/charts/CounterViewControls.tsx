import { Segmented } from "../Controls"
import type { CounterViewState } from "./counters"
import { RECENT_WINDOWS, autoWindowLabel, windowFits } from "./counterTrends"
import type { Baseline, CounterView, RecentWindow } from "./counterTrends"
import type { HistoryRange } from "./useDriveHistory"
import "./CounterLanesChart.css"

const VIEWS: { value: CounterView; label: string; title: string }[] = [
  { value: "total", label: "Total", title: "The running total" },
  { value: "events", label: "Events", title: "Each change, per drive" },
  { value: "rate", label: "Rate", title: "Change per bucket, against the usual" },
]

/** A counter card's view switch, plus — in Events and Rate — whether to draw
 *  the running total faintly behind the lanes. */
export default function CounterViewControls({ value, onChange, label, idPrefix }: {
  value: CounterViewState
  onChange: (next: CounterViewState) => void
  /** The counter's name, for the controls' accessible names. */
  label: string
  idPrefix?: string
}) {
  return (
    <div className="counter-view-ctl">
      {value.view !== "total" && (
        <label className="ctl-check">
          <input type="checkbox" checked={value.showTotal} onChange={e => onChange({ ...value, showTotal: e.target.checked })} />
          Show total
        </label>
      )}
      <Segmented label={`${label} view`} idPrefix={idPrefix} value={value.view} onChange={view => onChange({ ...value, view })}
        options={VIEWS} />
    </div>
  )
}

// ── window picks ─────────────────────────────────────────────────────────────
// The recent window (and Rate's comparison) as dropdowns inside a counter
// card's subtitle, so each sits in the words saying what it changes:
// "shaded: last [4h ▾] · band: usual [earlier in range ▾]".

interface PickProps {
  value: CounterViewState
  onChange: (next: CounterViewState) => void
  range: HistoryRange
  rangeMs: number
  idPrefix: string
}

/** The recent window the lanes shade and their status lines speak of. A
 *  window too long for the range is disabled, and one picked for a longer
 *  range reads as auto until it fits again. */
export function RecentPick({ value, onChange, range, rangeMs, idPrefix }: PickProps) {
  const shown = windowFits(value.recent, rangeMs) ? value.recent : "auto"
  return (
    <select id={`${idPrefix}-recent`} className="inline-select" value={shown} aria-label="Recent window"
      title="The recent window: shaded on the chart, and what the status lines speak of"
      onChange={e => onChange({ ...value, recent: e.target.value as RecentWindow })}>
      {RECENT_WINDOWS.map(w => (
        <option key={w} value={w} disabled={!windowFits(w, rangeMs)}>
          {w === "auto" ? `${autoWindowLabel(range)} (auto)` : w}
        </option>
      ))}
    </select>
  )
}

/** What Rate's band (and its status line) compares the recent window with. */
export function BaselinePick({ value, onChange, idPrefix, windowLabel }: PickProps & { windowLabel: string }) {
  return (
    <select id={`${idPrefix}-baseline`} className="inline-select" value={value.baseline} aria-label="Compare with"
      title="What the recent window is compared with: the band shows its usual change per bar"
      onChange={e => onChange({ ...value, baseline: e.target.value as Baseline })}>
      <option value="rest">earlier in range</option>
      <option value="prev">in the {windowLabel} before</option>
    </select>
  )
}
