import type { ReactNode } from "react"
import "./Controls.css"

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

// A row of mutually exclusive buttons (a time range, a scope). The pressed one
// takes the app's cyan "selected" treatment.
export function Segmented<T extends string>({ label, options, value, onChange, idPrefix }: {
  label: string
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  idPrefix?: string
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          id={idPrefix ? `${idPrefix}-${o.value}` : undefined}
          className="seg-btn"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// An on/off filter pill, for multi-select filters like job status.
export function FilterChip({ pressed, onToggle, children, title }: {
  pressed: boolean
  onToggle: () => void
  children: ReactNode
  title?: string
}) {
  return (
    <button className="filter-chip" aria-pressed={pressed} onClick={onToggle} title={title}>
      {children}
    </button>
  )
}

// Label + control pair inside a filter row.
export function Control({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="ctl">
      {htmlFor ? <label className="ctl-label" htmlFor={htmlFor}>{label}</label> : <span className="ctl-label">{label}</span>}
      {children}
    </div>
  )
}
