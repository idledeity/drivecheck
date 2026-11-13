import type { Drive } from "./types"
import { formatCapacity } from "./format"

export type DriveCopyField = {
  key: "name" | "serial" | "device" | "summary"
  /** The menu item's text, after "Copy". */
  label: string
  /** This drive's text for the field, or null when it has none. */
  value: (drive: Drive) => string | null
}

/** Manufacturer and model as the card shows them, e.g. "NETAPP X316_SMBPE06TA07". */
function makeModel(drive: Drive): string {
  return [drive.white_label ?? drive.manufacturer_short, drive.model ?? drive.device].filter(Boolean).join(" ")
}

// What the drive menu offers to copy, in menu order.
export const DRIVE_COPY_FIELDS: DriveCopyField[] = [
  // The user's label when there is one: that's the name they gave it.
  { key: "name", label: "Name", value: d => d.label ?? makeModel(d) },
  { key: "serial", label: "Serial", value: d => d.serial },
  { key: "device", label: "Device path", value: d => d.device },
  {
    key: "summary",
    label: "Summary",
    // e.g. "NETAPP X316_SMBPE06TA07 6 TB "Bay 3" · S/N ZAD1V2H0 · /dev/sdb · Failing (34/100)"
    value: d => [
      [makeModel(d), d.capacity_bytes ? formatCapacity(d.capacity_bytes) : null, d.label ? `"${d.label}"` : null].filter(Boolean).join(" "),
      `S/N ${d.serial ?? "—"}`,
      d.device,
      `${d.health_status ?? "Unrated"}${d.health_pct !== null ? ` (${d.health_pct}/100)` : ""}`,
    ].join(" · "),
  },
]

/**
 * The field for each drive, one per line, skipping drives without one; null
 * when none of them has it (the menu then leaves the item out).
 */
export function driveCopyText(field: DriveCopyField, drives: Drive[]): string | null {
  const lines = drives.map(field.value).filter((v): v is string => v !== null && v !== "")
  return lines.length > 0 ? lines.join("\n") : null
}
