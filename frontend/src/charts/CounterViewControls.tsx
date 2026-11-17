import { Segmented } from "../Controls"
import type { CounterViewState } from "./counters"
import type { CounterView } from "./counterTrends"
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
