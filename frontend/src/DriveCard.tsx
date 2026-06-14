import { useRef, useState } from "react"
import { IconArrowDown, IconArrowUp, IconClock, IconPencil, IconServer, IconTemperature } from "@tabler/icons-react"
import type { Drive } from "./types"
import { SIGNALS, DEFAULT_FOOTER_SIGNALS } from "./signals"
import { formatCapacity, formatRelativeTime, formatThroughput } from "./format"
import "./DriveCard.css"

interface Props {
  drive: Drive
  selected: boolean
  onSelect: () => void
  footerSignals?: Record<string, string[]>
  onLabelChange?: (guid: string, label: string | null) => void
}

export default function DriveCard({ drive, selected, onSelect, footerSignals, onLabelChange }: Props) {
  const health  = drive.health_status ? HEALTH_DISPLAY[drive.health_status] : HEALTH_DISPLAY.Unrated
  const tempHot = drive.signal_flags?.temp === "warn"
  const sigMap  = footerSignals ?? DEFAULT_FOOTER_SIGNALS
  const sigKeys = sigMap[drive.drive_type ?? "default"] ?? sigMap["default"]
  const liveTemp = drive.vitals.temp ?? drive.temp
  const io = drive.vitals.io

  const [editingLabel, setEditingLabel] = useState(false)
  const [labelInput, setLabelInput] = useState("")
  const cancelLabelEdit = useRef(false)

  const startLabelEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setLabelInput(drive.label ?? "")
    setEditingLabel(true)
  }

  const commitLabelEdit = () => {
    setEditingLabel(false)
    if (cancelLabelEdit.current) {
      cancelLabelEdit.current = false
      return
    }
    const next = labelInput.trim() || null
    if (next !== drive.label) onLabelChange?.(drive.guid, next)
  }

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
        {editingLabel ? (
          <input
            className="dc-label-input"
            autoFocus
            value={labelInput}
            placeholder="Label…"
            onClick={e => e.stopPropagation()}
            onChange={e => setLabelInput(e.target.value)}
            onBlur={commitLabelEdit}
            onKeyDown={e => {
              if (e.key === "Enter") e.currentTarget.blur()
              else if (e.key === "Escape") { cancelLabelEdit.current = true; e.currentTarget.blur() }
            }}
          />
        ) : drive.label ? (
          <span className="dc-label" onClick={startLabelEdit} title="Click to edit label">({drive.label})</span>
        ) : (
          <button className="dc-label-edit" onClick={startLabelEdit} title="Add label">
            <IconPencil size={14} />
          </button>
        )}
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
        {liveTemp !== null && (
          <>
            <span className="dc-tsep">·</span>
            <span className="dc-si" title={drive.vitals.temp_source ? `Source: ${drive.vitals.temp_source}` : undefined}>
              <IconTemperature size={11} />
              <span className={`dc-sv${tempHot ? " hot" : ""}`}>{liveTemp}°C</span>
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
        <div className="dc-fs" title={drive.last_polled_at ? `Telemetry updated ${formatRelativeTime(drive.last_polled_at)}` : undefined}>
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
        <div className="dc-io">
          <div className="dc-io-row rd">{formatThroughput(io.read_bytes_per_sec)}<IconArrowUp size={9} /></div>
          <div className="dc-io-row wr">{formatThroughput(io.write_bytes_per_sec)}<IconArrowDown size={9} /></div>
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

