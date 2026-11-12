import { IconLock } from "@tabler/icons-react"
import type { Drive } from "./types"
import { formatCapacity } from "./format"
import "./DriveChip.css"

interface Props {
  drive: Drive
  // Marks the chip when the drive's state blocks what's being set up, e.g. a
  // locked drive among the targets of a destructive operation.
  blocked?: boolean
}

const HEALTH_CLASS: Record<string, string> = { Healthy: "ok", Degraded: "warn", Failing: "crit" }

// Compact identity pill for a drive: a dot in its health color, manufacturer,
// name, capacity and serial. Inside a .drive-chip-list, a container query
// shortens the serial to its last four characters when space is tight, then
// drops the manufacturer (DriveChip.css). The full details are always in the
// hover title.
export default function DriveChip({ drive, blocked = false }: Props) {
  const name = drive.label ?? drive.model ?? drive.device
  const tail = drive.serial ? drive.serial.slice(-4) : null
  // Skip the manufacturer when the name already starts with it ("WDC WD40EFRX").
  const maker = drive.manufacturer_short
  const showMaker = maker && !name.toLowerCase().startsWith(maker.toLowerCase())
  const capacity = drive.capacity_bytes === null ? null : formatCapacity(drive.capacity_bytes)
  const health = drive.health_status
    ? `${drive.health_status}${drive.health_pct === null ? "" : ` ${drive.health_pct}`}`
    : "Not rated"
  const title = [drive.model, drive.serial, drive.device, capacity, health].filter(Boolean).join(" · ")
  return (
    <span className={`drive-chip${blocked ? " blocked" : ""}`} title={title}>
      <span
        className={`drive-chip-health ${HEALTH_CLASS[drive.health_status ?? ""] ?? "none"}`}
        role="img"
        aria-label={health}
      />
      {showMaker && <span className="drive-chip-maker">{maker}</span>}
      <span className="drive-chip-name">{name}</span>
      {capacity && <span className="drive-chip-meta">{capacity}</span>}
      {drive.serial && (
        <span className="drive-chip-serial">
          <span className="drive-chip-serial-full">{drive.serial}</span>
          <span className="drive-chip-serial-tail" aria-hidden="true">{tail}</span>
        </span>
      )}
      {drive.locked && <IconLock size={11} className="drive-chip-lock" aria-label="locked" />}
    </span>
  )
}
