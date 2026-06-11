import { IconClock, IconServer, IconTemperature } from "@tabler/icons-react"
import type { Drive } from "./types"
import { SIGNALS, DEFAULT_FOOTER_SIGNALS } from "./signals"
import { formatCapacity } from "./format"
import "./DriveCard.css"

interface Props {
  drive: Drive
  selected: boolean
  onSelect: () => void
  footerSignals?: Record<string, string[]>
}

export default function DriveCard({ drive, selected, onSelect, footerSignals }: Props) {
  const health  = drive.health_status ? HEALTH_DISPLAY[drive.health_status] : HEALTH_DISPLAY.Unrated
  const tempHot = drive.signal_flags?.temp === "warn"
  const sigMap  = footerSignals ?? DEFAULT_FOOTER_SIGNALS
  const sigKeys = sigMap[drive.drive_type ?? "default"] ?? sigMap["default"]

  return (
    <div
      className={`drive-card bar-${health.bar}${selected ? " sel" : ""}`}
      onClick={onSelect}
    >
      {/* Row 1: name + badge */}
      <div className="dc-r1">
        <div className="dc-sel-btn" />
        {drive.manufacturer && <span className="dc-mfr">{drive.manufacturer}</span>}
        <span className="dc-model">{drive.model ?? drive.device}</span>
        {drive.capacity_bytes && <span className="dc-model dc-cap">{formatCapacity(drive.capacity_bytes)}</span>}
        <span className={`dc-badge dc-badge-${health.bar}`}>{health.label}</span>
      </div>

      {/* Row 2: traits (left) + serial (right) */}
      <div className="dc-traits">
        <div className="dc-traits-left">
          {drive.drive_type && <span className="dc-tv">{drive.drive_type}</span>}
          {drive.capacity_bytes != null && (
            <><span className="dc-tsep">·</span><span className="dc-tv">{formatCapacity(drive.capacity_bytes)}</span></>
          )}
          {drive.rpm && (
            <><span className="dc-tsep">·</span><span className="dc-tv">{(drive.rpm / 1000).toFixed(1)}k RPM</span></>
          )}
          {drive.bus && (
            <><span className="dc-tsep">·</span><span className="dc-tv">{drive.bus}</span></>
          )}
        </div>
        {drive.serial && <span className="dc-serial">S/N {drive.serial}</span>}
      </div>

      {/* Decorative leader line — 2/3 width */}
      <div className="dc-ldr"><div className="dc-ldr-line" /></div>

      {/* Row 3: active state — path + temp */}
      <div className="dc-state">
        <span className="dc-si"><IconServer size={11} /><span className="dc-sv">{drive.device}</span></span>
        {drive.temp !== null && (
          <>
            <span className="dc-tsep">·</span>
            <span className="dc-si">
              <IconTemperature size={11} />
              <span className={`dc-sv${tempHot ? " hot" : ""}`}>{drive.temp}°C</span>
            </span>
          </>
        )}
      </div>

      {/* Task zone */}
      <div className="dc-tz idle">
        <div className="dc-tn">
          <IconClock size={11} />
          <span>Idle</span>
        </div>
      </div>

      {/* Footer */}
      <div className="dc-ft">
        <div className="dc-fs">
          {sigKeys.map(key => {
            const desc = SIGNALS[key]
            if (!desc) return null
            const val = drive[key as keyof Drive]
            const flag = drive.signal_flags?.[key]
            return (
              <Stat
                key={key}
                label={desc.label}
                value={desc.format(val)}
                warn={flag === "warn"}
                crit={flag === "crit"}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, warn, crit }: { label: string; value: string | number; warn?: boolean; crit?: boolean }) {
  const cls = crit ? " crit" : warn ? " warn" : ""
  return (
    <div className="dc-stat">
      <div className="dc-stat-label">{label}</div>
      <div className={`dc-stat-value${cls}`}>{value}</div>
    </div>
  )
}

const HEALTH_DISPLAY: Record<string, { bar: "green" | "warn" | "red" | "grey"; label: string }> = {
  Healthy:  { bar: "green", label: "SMART OK" },
  Degraded: { bar: "warn",  label: "Degraded" },
  Failing:  { bar: "red",   label: "Failing"  },
  Unrated:  { bar: "grey",  label: "Unrated"  },
}

