import { IconClock, IconServer, IconTemperature } from "@tabler/icons-react"
import type { Drive } from "./types"
import "./DriveCard.css"

interface Props {
  drive: Drive
  selected: boolean
  onSelect: () => void
}

export default function DriveCard({ drive, selected, onSelect }: Props) {
  const health = deriveHealth(drive)
  const tempHot = (drive.temp ?? 0) >= 45

  return (
    <div
      className={`drive-card bar-${health.bar}${selected ? " sel" : ""}`}
      onClick={onSelect}
    >
      <div className="dc-hrow">
        <div className="dc-tcol">
          <div className="dc-dname">
            <div className="dc-sel-btn" />
            {drive.model ?? drive.device}
          </div>
          <div className="dc-irow">
            {drive.drive_type && <><span className="dc-ival">{drive.drive_type}</span><span className="dc-isep">·</span></>}
            <span className="dc-ival">{formatCapacity(drive.capacity_bytes)}</span>
            {drive.bus && <><span className="dc-isep">·</span><span className="dc-ival">{drive.bus}</span></>}
          </div>
          <div className="dc-ldr"><div className="dc-ldr-line" /></div>
        </div>
        <div className="dc-rcol">
          <span className={`dc-badge dc-badge-${health.bar}`}>{health.label}</span>
          {drive.serial && <span className="dc-serial">{drive.serial}</span>}
        </div>
      </div>

      <div className="dc-gap" />

      <div className="dc-srow">
        {drive.temp !== null && (
          <>
            <span className="dc-si">
              <IconTemperature size={12} />
              <span className={`dc-sv${tempHot ? " hot" : ""}`}>{drive.temp}°C</span>
            </span>
            <span className="dc-ss">·</span>
          </>
        )}
        <span className="dc-si">
          <IconServer size={12} />
          <span className="dc-sv">{drive.device}</span>
        </span>
      </div>

      <div className="dc-gap" />

      <div className="dc-tz idle">
        <div className="dc-tn">
          <IconClock size={11} />
          <span>Idle</span>
        </div>
      </div>

      <div className="dc-gap" />

      <div className="dc-ft">
        <div className="dc-fs">
          <Stat label="Power-on" value={drive.power_on_hours !== null ? `${drive.power_on_hours.toLocaleString()}h` : "—"} />
          <Stat label="Realloc"  value={drive.reallocated ?? "—"} warn={(drive.reallocated ?? 0) > 0} />
          {drive.drive_type === "SAS"
            ? <Stat label="Ld/UL" value={drive.load_unload_cycles !== null ? drive.load_unload_cycles.toLocaleString() : "—"} />
            : <Stat label="Pending" value={drive.pending ?? "—"} warn={(drive.pending ?? 0) > 0} />
          }
          <Stat label="Uncorr"   value={drive.uncorrected ?? "—"} crit={(drive.uncorrected ?? 0) > 0} />
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

function deriveHealth(drive: Drive): { bar: "green" | "warn" | "red" | "grey"; label: string } {
  if (drive.smart_passed === false)
    return { bar: "red", label: "Failing" }
  if ((drive.reallocated ?? 0) > 0 || (drive.uncorrected ?? 0) > 0)
    return { bar: "warn", label: "Degraded" }
  if (drive.smart_passed === true)
    return { bar: "green", label: "SMART OK" }
  return { bar: "grey", label: "Unrated" }
}

function formatCapacity(bytes: number | null): string {
  if (bytes === null) return "—"
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(0)} TB`
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(0)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
}
