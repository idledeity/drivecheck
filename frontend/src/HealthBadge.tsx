import type { HTMLAttributes } from "react"
import { healthDisplay } from "./healthBands"
import "./HealthBadge.css"

interface Props extends HTMLAttributes<HTMLSpanElement> {
  status: string | null | undefined
  score: number | null | undefined
}

// The health status as a pill, with the score in a small inner pill when
// there is one. Extra props (e.g. a popover trigger's) go on the pill.
export default function HealthBadge({ status, score, className, ...rest }: Props) {
  const { tone, label } = healthDisplay(status)
  return (
    <span className={`health-badge health-badge-${tone}${className ? ` ${className}` : ""}`} {...rest}>
      <span>{label}</span>
      {score != null && <span className="health-badge-score">{score}</span>}
    </span>
  )
}
