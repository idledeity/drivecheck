import type { ParamSpec } from "./types"

// Param values for the Run Task form: an operation's params or a recipe's.

// The same rules the backend applies (validate_params): a "number" is a whole
// number within min/max. Checked here so a bad value is caught at the field
// rather than refused after Run.
export function paramError(spec: ParamSpec, value: unknown): string | null {
  if (spec.type !== "number") return null
  if (typeof value !== "number" || !Number.isInteger(value)) return "Enter a whole number"
  if (spec.min !== null && value < spec.min) return `Must be at least ${spec.min}`
  if (spec.max !== null && value > spec.max) return `Must be at most ${spec.max}`
  return null
}

/** Each param's default, keyed by name: a form's starting values. */
export function paramDefaults(specs: ParamSpec[]): Record<string, unknown> {
  return Object.fromEntries(specs.map(p => [p.name, p.default]))
}

/** Each param's validation error (paramError), keyed by name. */
export function paramErrors(specs: ParamSpec[], values: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(specs.map(spec => [spec.name, paramError(spec, values[spec.name])]))
}
