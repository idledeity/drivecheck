import { formatSignal, severityClass } from "./signals"
import type { SignalRaw } from "./signals"
import "./signals.css"

// A drive signal's value, formatted from the shared registry and coloured by
// its backend severity flag. Use this anywhere a signal value is displayed so
// the colour and format can't drift between views. className carries the
// view's own typography (size, weight, base colour); severity overrides colour.
export default function SignalValue({ signal, value, flag, className }: {
  signal: string
  value: SignalRaw
  flag?: string | null
  className?: string
}) {
  const cls = ["sig-value", className, severityClass(flag)].filter(Boolean).join(" ")
  return <span className={cls}>{formatSignal(signal, value)}</span>
}
