import type { Drive } from "./types"
import { formatCapacity } from "./format"
import { useEdgeFade } from "./useEdgeFade"
import Serial from "./Serial"
import "./DriveIdentity.css"

interface Props {
  drive?: Drive
  className?: string
  showSerial?: boolean
}

export default function DriveIdentity({ drive, className, showSerial = true }: Props) {
  const fade = useEdgeFade<HTMLDivElement>()
  return (
    <div className={`drive-identity${className ? ` ${className}` : ""}`}>
      <div ref={fade.ref} className={`di-id${fade.fade ? " di-edge-fade" : ""}`}>
        {drive?.manufacturer && <span className="di-mfr">{drive.manufacturer}</span>}
        <span className="di-model">{drive ? (drive.model ?? drive.device) : "Unknown drive"}</span>
        {drive?.capacity_bytes != null && <span className="di-model di-cap">{formatCapacity(drive.capacity_bytes)}</span>}
        {drive?.label && <span className="di-label">({drive.label})</span>}
      </div>
      {showSerial && drive?.serial && <Serial value={drive.serial} className="di-serial" />}
    </div>
  )
}
