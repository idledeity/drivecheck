import type { HealthFactor } from "./types"
import "./HealthFactors.css"

// What made a health score, worst first: the first factor sets it (its
// standalone score), each other lowers it by the points shown. A floor note
// says when age/wear/heat alone held the score up.
export default function HealthFactors({ factors, floor, scored }: {
  factors: HealthFactor[]
  floor: number | null
  /** Whether there's a score at all (no verdict = Unrated: say nothing). */
  scored: boolean
}) {
  if (!scored) return null
  if (factors.length === 0) return <p className="hf-none">Nothing lowers the score</p>
  return (
    <div className="hf">
      {factors.map(f => (
        <div key={f.key} className={`hf-row ${factorSeverity(f)}`}>
          <span className="hf-label">{f.label}</span>
          <span className="hf-value">{f.value}</span>
          <span className="hf-points" title={f.role === "start"
            ? `Worst problem: the score starts at ${Math.round(f.points)}`
            : `Lowers the score by ${Math.abs(f.points).toFixed(1)}`}>{formatPoints(f)}</span>
        </div>
      ))}
      {floor !== null && (
        <p className="hf-floor">Held at {floor}: age, wear and heat alone don't lower it further</p>
      )}
    </div>
  )
}

export function factorSeverity(f: HealthFactor): "crit" | "warn" | "mild" {
  return f.standalone < 40 ? "crit" : f.standalone < 80 ? "warn" : "mild"
}

export function formatPoints(f: HealthFactor): string {
  if (f.role === "start") return `${Math.round(f.points)}`
  return f.points > -0.05 ? "−<0.1" : `−${Math.abs(f.points).toFixed(1)}`
}
