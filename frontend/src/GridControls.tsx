import { useEffect, useRef, useState } from "react"
import { IconArrowsSort, IconDeselect, IconRefresh, IconScan, IconSelectAll, IconSettings } from "@tabler/icons-react"
import type { Drive, SortKey, SortState } from "./types"

interface Props {
  drives: Drive[]
  selected: string[]
  onSelectAll: () => void
  onUnselectAll: () => void
  onProbe: () => Promise<unknown>
  onScan: () => Promise<unknown>
  onOpenSettings: () => void
  sort: SortState
  onSortChange: (sort: SortState) => void
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "label",        label: "Custom Name" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "model",        label: "Model Number" },
  { key: "capacity",     label: "Capacity" },
  { key: "health",       label: "Health Status" },
  { key: "active_task",  label: "Active Task" },
  { key: "first_seen",   label: "Date Added" },
  { key: "locked",       label: "Lock Status" },
  { key: "device",       label: "/dev device" },
  { key: "serial",       label: "Serial Number" },
]

export default function GridControls({ drives, selected, onSelectAll, onUnselectAll, onProbe, onScan, onOpenSettings, sort, onSortChange }: Props) {
  const [probing, setProbing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const sortWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sortOpen) return
    const close = (e: MouseEvent) => {
      if (sortWrapRef.current && !sortWrapRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [sortOpen])

  const handleProbe = () => {
    setProbing(true)
    onProbe().finally(() => setProbing(false))
  }

  const handleScan = () => {
    setScanning(true)
    onScan().finally(() => setScanning(false))
  }

  const handleSortSelect = (key: SortKey) => {
    if (sort.key === key) {
      onSortChange({ key, dir: sort.dir === "asc" ? "desc" : "asc" })
    } else {
      onSortChange({ key, dir: "asc" })
    }
    setSortOpen(false)
  }

  const probeLabel = selected.length > 0 ? `Probe selected (${selected.length})` : "Probe all drives"
  const activeSortLabel = SORT_OPTIONS.find(o => o.key === sort.key)?.label

  return (
    <div className="grid-controls">
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
      <button className="gc-btn" onClick={handleProbe} disabled={probing} title={probeLabel}>
        <IconRefresh size={13} className={probing ? "spinning" : ""} />
        <span className="gc-probe-label">{probeLabel}</span>
      </button>
      <span className="gc-sep" />
      <div ref={sortWrapRef} className="gc-sort-wrap">
        <button
          className="gc-btn"
          onClick={() => setSortOpen(o => !o)}
          title="Sort drives"
        >
          <IconArrowsSort size={13} />
          <span>{activeSortLabel}</span>
          <span className="gc-sort-dir">{sort.dir === "asc" ? "↑" : "↓"}</span>
        </button>
        {sortOpen && (
          <div className="gc-sort-dropdown">
            {SORT_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                className={`gc-sort-item${sort.key === key ? " gc-sort-item-active" : ""}`}
                onClick={() => handleSortSelect(key)}
              >
                <span>{label}</span>
                {sort.key === key && <span className="gc-sort-item-dir">{sort.dir === "asc" ? "↑" : "↓"}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="gc-btn" onClick={onOpenSettings} title="Settings">
        <IconSettings size={13} />
        <span>Settings</span>
      </button>
    </div>
  )
}
