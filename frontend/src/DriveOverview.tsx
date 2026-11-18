import { IconInfoCircle } from "@tabler/icons-react"
import type { Drive } from "./types"
import { signalLabel } from "./signals"
import SignalValue from "./SignalValue"
import { DriveChipHeader } from "./DriveChip"
import AsOf from "./AsOf"
import ReadSmartButton from "./ReadSmartButton"
import HoverReveal from "./HoverReveal"
import HealthFactors from "./HealthFactors"
import { healthBandText } from "./healthBands"
import { isStale, useNow } from "./useNow"
import "./DriveOverview.css"

// A drive's health at a glance: score, what made it, temperature and
// power-on hours. Shown on Health > Overview, and without the drive header
// in the health popover on that drive's card. Everything but temperature is
// from one SMART read, dated at the bottom (with Read now); live temperature is dated only
// once it's overdue.
export default function DriveOverview({ drive, header = true }: { drive: Drive; header?: boolean }) {
  const liveTemp = drive.vitals.temp ?? drive.temp

  return (
    <div className="hov-section">
      {header && <DriveChipHeader drive={drive} />}

      <HealthScoreBar score={drive.health_pct} status={drive.health_status} />
      <HealthFactors factors={drive.health_factors ?? []} floor={drive.health_floor ?? null} scored={drive.health_pct !== null} />

      <div className="hov-stats">
        <HealthStat drive={drive} signal="temp" value={liveTemp} liveAt={drive.vitals.temp !== null ? drive.vitals.captured_at : null} />
        <HealthStat drive={drive} signal="power_on_hours" value={drive.power_on_hours} />
      </div>

      <p className="hov-asof">
        {drive.last_polled_at
          ? <>SMART read <AsOf at={drive.last_polled_at} staleAfterS={drive.stale_after_s.smart} /></>
          : "No SMART read yet"}
        {" · "}<ReadSmartButton guids={[drive.guid]} />
      </p>
    </div>
  )
}

// The health score as a bar, number and status word, with what the status
// means (and roughly how often such drives fail) behind the (i).
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
      <HoverReveal text={healthBandText(status)}>
        <IconInfoCircle size={12} className="cfg-tooltip-icon" aria-label="About this health status" />
      </HoverReveal>
    </div>
  )
}

function scoreColorCls(status: string | null): string {
  if (status === "Healthy" || status === "Aging") return "score-ok"
  if (status === "Degraded") return "score-warn"
  if (status === "Failing" || status === "Critical") return "score-fail"
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
