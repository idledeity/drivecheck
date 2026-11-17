import type { Drive } from "./types"
import { REPORT_SIGNALS, formatSignal, signalLabel } from "./signals"
import SignalValue from "./SignalValue"
import { DriveChipHeader } from "./DriveChip"
import AsOf from "./AsOf"
import { isStale, useNow } from "./useNow"
import "./DriveOverview.css"

// A drive's health at a glance: score, temperature, power-on hours and any
// flagged signals. Shown on Health > Overview, and without the drive header
// in the health popover on that drive's card. Everything but temperature is
// from one SMART read, dated at the bottom; live temperature is dated only
// once it's overdue.
export default function DriveOverview({ drive, header = true }: { drive: Drive; header?: boolean }) {
  const score    = drive.health_pct
  const liveTemp = drive.vitals.temp ?? drive.temp

  const flagged = Object.entries(drive.signal_flags ?? {})
    .filter(([key, sev]) => REPORT_SIGNALS.includes(key) && (sev === "warn" || sev === "crit"))
    .sort(([, a], [, b]) => (a === "crit" ? -1 : b === "crit" ? 1 : 0))

  return (
    <div className="hov-section">
      {header && <DriveChipHeader drive={drive} />}

      <HealthScoreBar score={drive.health_pct} status={drive.health_status} />

      <div className="hov-stats">
        <HealthStat drive={drive} signal="temp" value={liveTemp} liveAt={drive.vitals.temp !== null ? drive.vitals.captured_at : null} />
        <HealthStat drive={drive} signal="power_on_hours" value={drive.power_on_hours} />
      </div>

      {flagged.length > 0 ? (
        <div className="hov-flags">
          {flagged.map(([key, sev]) => (
            <span key={key} className={`hov-flag-chip ${sev}`}>
              {signalLabel(key)}: {formatSignal(key, drive[key as keyof Drive] as number | null)}
            </span>
          ))}
        </div>
      ) : score !== null ? (
        <p className="hov-no-flags">No flagged signals</p>
      ) : null}

      {drive.last_polled_at && (
        <p className="hov-asof">SMART read <AsOf at={drive.last_polled_at} staleAfterS={drive.stale_after_s.smart} /></p>
      )}
    </div>
  )
}

// The health score as a bar, number and status word.
export function HealthScoreBar({ score, status }: { score: number | null; status: string | null }) {
  const colorCls = scoreColorCls(status)
  return (
    <div className="hov-score-row">
      <div className="hov-score-track">
        <div
          className={`hov-score-fill ${colorCls}`}
          style={{ width: score !== null ? `${score}%` : "0%" }}
        />
      </div>
      <span className={`hov-score-num ${colorCls}`}>{score ?? "—"}</span>
      <span className={`hov-score-label ${colorCls}`}>{status ?? "Unrated"}</span>
    </div>
  )
}

function scoreColorCls(status: string | null): string {
  if (status === "Healthy")  return "score-ok"
  if (status === "Degraded") return "score-warn"
  if (status === "Failing")  return "score-fail"
  return "score-unrated"
}

function HealthStat({ drive, signal, value, liveAt = null }: {
  drive: Drive
  signal: string
  value: number | null
  /** For a live (vitals) value: when it was read, shown only once overdue. */
  liveAt?: string | null
}) {
  const now = useNow()
  const overdue = isStale(liveAt, drive.stale_after_s.vitals, now)
  return (
    <div className="hov-stat">
      <div className="hov-stat-label">{signalLabel(signal)}</div>
      <SignalValue className="hov-stat-value" signal={signal} value={value} flag={drive.signal_flags?.[signal]} />
      {overdue && liveAt && <AsOf className="hov-stat-asof" at={liveAt} staleAfterS={drive.stale_after_s.vitals} />}
    </div>
  )
}
