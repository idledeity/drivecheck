import { IconInfoCircle } from "@tabler/icons-react"
import type { ParamSpec } from "./types"
import HoverReveal from "./HoverReveal"

// Param inputs for the Run Task form: an operation's params or a recipe's.
// Styles are RunTaskForm.css's (.rt-param*).

export function ParamInput({ spec, value, error, onChange }: { spec: ParamSpec; value: unknown; error: string | null; onChange: (value: unknown) => void }) {
  if (spec.type === "boolean") {
    return (
      <label className="rt-param rt-param-bool">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={e => onChange(e.target.checked)}
        />
        {spec.label}
        <ParamTooltip spec={spec} />
      </label>
    )
  }

  if (spec.type === "number") {
    return (
      <label className="rt-param">
        <span className="rt-param-label">{spec.label}<ParamTooltip spec={spec} /></span>
        <input
          type="number"
          step={1}
          value={value === null ? "" : value as number}
          min={spec.min ?? undefined}
          max={spec.max ?? undefined}
          aria-invalid={error !== null}
          aria-describedby={error ? `rt-param-error-${spec.name}` : undefined}
          onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
        {error && <span className="rt-param-error" id={`rt-param-error-${spec.name}`}>{error}</span>}
      </label>
    )
  }

  return (
    <label className="rt-param">
      <span className="rt-param-label">{spec.label}<ParamTooltip spec={spec} /></span>
      <input
        type="text"
        value={value as string}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}

export function ParamTooltip({ spec }: { spec: ParamSpec }) {
  if (!spec.tooltip) return null
  return (
    <HoverReveal text={spec.tooltip}>
      <IconInfoCircle size={12} className="cfg-tooltip-icon" aria-label={`About ${spec.label}`} />
    </HoverReveal>
  )
}

/** Shown when a destructive run is blocked by locked drives. */
export function LockWarning({ count }: { count: number }) {
  return (
    <div className="rt-lock-warning">
      {count === 1 ? "1 drive is" : `${count} drives are`} locked — unlock before running a destructive operation.
    </div>
  )
}
