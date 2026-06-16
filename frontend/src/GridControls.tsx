import { useState } from "react"
import { IconDeselect, IconRefresh, IconScan, IconSelectAll, IconSettings } from "@tabler/icons-react"
import type { Drive } from "./types"

interface Props {
  drives: Drive[]
  selected: string[]
  onSelectAll: () => void
  onUnselectAll: () => void
  onProbe: () => Promise<unknown>
  onScan: () => Promise<unknown>
  onOpenSettings: () => void
}

export default function GridControls({ drives, selected, onSelectAll, onUnselectAll, onProbe, onScan, onOpenSettings }: Props) {
  const [probing, setProbing] = useState(false)
  const [scanning, setScanning] = useState(false)

  const handleProbe = () => {
    setProbing(true)
    onProbe().finally(() => setProbing(false))
  }

  const handleScan = () => {
    setScanning(true)
    onScan().finally(() => setScanning(false))
  }

  const probeLabel = selected.length > 0 ? `Probe selected (${selected.length})` : "Probe all drives"

  return (
    <div className="grid-controls">
      <button className="gc-btn" onClick={handleProbe} disabled={probing} title={probeLabel}>
        <IconRefresh size={13} className={probing ? "spinning" : ""} />
        <span className="gc-probe-label">{probeLabel}</span>
      </button>
      <span className="gc-sep" />
      <button className="gc-btn" onClick={onSelectAll} disabled={drives.length === 0 || selected.length === drives.length} title="Select all drives">
        <IconSelectAll size={13} />
        <span>Select all</span>
      </button>
      <button className="gc-btn" onClick={onUnselectAll} disabled={selected.length === 0} title="Clear selection">
        <IconDeselect size={13} />
        <span>Unselect all</span>
      </button>
      <span className="gc-sep" />
      <button className="gc-btn" onClick={handleScan} disabled={scanning} title="Scan for drives">
        <IconScan size={13} className={scanning ? "spinning" : ""} />
        <span>Scan for drives</span>
      </button>
      <span className="gc-sep" />
      <button className="gc-btn" onClick={onOpenSettings} title="Settings">
        <IconSettings size={13} />
        <span>Settings</span>
      </button>
    </div>
  )
}
