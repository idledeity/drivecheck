import { IconBarcode, IconLock } from "@tabler/icons-react"
import type { ReactNode } from "react"
import type { Drive } from "./types"
import { formatCapacity } from "./format"
import "./DriveChip.css"

interface Props {
  // Absent when a job or view refers to a drive that is no longer present.
  drive?: Drive
  // Marks the chip when the drive's state blocks what's being set up, e.g. a
  // locked drive among the targets of a destructive operation.
  blocked?: boolean
  // "auto": full serial, shortened by the container query when space is
  // tight. "tail": always the last four characters, for rows where the chip
  // can't sit in a size container (the full serial stays in the title).
  serial?: "auto" | "tail"
  // Shown first, in place of the health dot: e.g. a chart's line key, where
  // the chip doubles as a legend entry and a second colored mark would compete
  // with it. Health stays in the hover title.
  lead?: ReactNode
  // No pill (border, fill, padding): for dense lists like a chart tooltip,
  // where a stack of outlined pills is more frame than content.
  thin?: boolean
}

const HEALTH_CLASS: Record<string, string> = { Healthy: "ok", Degraded: "warn", Failing: "crit" }

// Compact identity pill for a drive: a dot in its health color, manufacturer,
// name, capacity and serial. Inside a .drive-chip-list, a container query
// shortens the serial to its last four characters when space is tight, then
// drops the manufacturer (DriveChip.css). The full details are always in the
// hover title.
export default function DriveChip({ drive, blocked = false, serial = "auto", lead, thin = false }: Props) {
  const cls = `drive-chip${thin ? " thin" : ""}`
  if (!drive) {
    return (
      <span className={cls}>
        {lead ?? <span className="drive-chip-health none" role="img" aria-label="Not rated" />}
        <span className="drive-chip-name">Unknown drive</span>
      </span>
    )
  }
  const name = drive.label ?? drive.model ?? drive.device
  const tail = drive.serial ? drive.serial.slice(-4) : null
  // Same maker as the drive card shows; skipped when the name already starts
  // with it ("WDC WD40EFRX").
  const maker = drive.white_label ?? drive.manufacturer_short
  const showMaker = maker && !name.toLowerCase().startsWith(maker.toLowerCase())
  const capacity = drive.capacity_bytes === null ? null : formatCapacity(drive.capacity_bytes)
  const health = drive.health_status
    ? `${drive.health_status}${drive.health_pct === null ? "" : ` ${drive.health_pct}`}`
    : "Not rated"
  const model = drive.model ?? drive.device
  const title = [drive.label ? `${drive.label} (${model})` : model, drive.serial, drive.device, capacity, health]
    .filter(Boolean)
    .join(" · ")
  return (
    <span className={`${cls}${blocked ? " blocked" : ""}`} title={title}>
      {lead ?? (
        <span
          className={`drive-chip-health ${HEALTH_CLASS[drive.health_status ?? ""] ?? "none"}`}
          role="img"
          aria-label={health}
        />
      )}
      {showMaker && <span className="drive-chip-maker">{maker}</span>}
      <span className="drive-chip-name">{name}</span>
      {capacity && <span className="drive-chip-meta">{capacity}</span>}
      {drive.serial && (
        <span className={`drive-chip-serial${serial === "tail" ? " tail-only" : ""}`}>
          <IconBarcode size={11} aria-hidden="true" />
          {serial === "auto" && <span className="drive-chip-serial-full">{drive.serial}</span>}
          <span className="drive-chip-serial-tail" aria-hidden={serial === "auto" ? "true" : undefined}>{tail}</span>
        </span>
      )}
      {drive.locked && <IconLock size={11} className="drive-chip-lock" aria-label="locked" />}
    </span>
  )
}

// One chip on its own line, still inside a size container so the serial and
// manufacturer shorten when the line is narrow: for drive section headers.
export function DriveChipHeader({ drive, className }: { drive?: Drive; className?: string }) {
  return (
    <div className={`drive-chip-list${className ? ` ${className}` : ""}`}>
      <DriveChip drive={drive} />
    </div>
  )
}
