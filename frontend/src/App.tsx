import { useEffect, useState } from "react"
import { IconRefresh, IconDeselect } from "@tabler/icons-react"
import DriveCard from "./DriveCard"
import WorkspacePanel from "./WorkspacePanel"
import type { CollectorStatus, Drive, Settings } from "./types"
import { formatRelativeTime } from "./format"
import "./App.css"

export default function App() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [collectorStatus, setCollectorStatus] = useState<CollectorStatus | null>(null)

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(setSettings).catch(() => {})
  }, [])

  const loadDrives = () =>
    fetch("/api/drives")
      .then(r => r.json())
      .then(setDrives)
      .catch(e => setError(String(e)))

  const loadCollectorStatus = () =>
    fetch("/api/collector/status")
      .then(r => r.json())
      .then(setCollectorStatus)
      .catch(() => {})

  useEffect(() => {
    loadDrives()
    loadCollectorStatus()
    // /api/drives is an in-memory read (no subprocess calls), so poll it
    // faster than the collector's 10s vitals cadence to keep the live
    // temp/IO readings on each DriveCard feeling current.
    const id = setInterval(() => { loadDrives(); loadCollectorStatus() }, 2_000)
    return () => clearInterval(id)
  }, [])

  const handleRefresh = () => {
    setRefreshing(true)
    fetch("/api/drives/refresh", { method: "POST" })
      .then(() => Promise.all([loadDrives(), loadCollectorStatus()]))
      .catch(e => setError(String(e)))
      .finally(() => setRefreshing(false))
  }

  const toggleSelect = (guid: string) => {
    setSelected(prev => prev.includes(guid) ? prev.filter(g => g !== guid) : [...prev, guid])
  }

  if (error) return <div className="status-error">Error: {error}</div>

  return (
    <div>
      <div className="page-label">
        drivecheck <span>/ drives</span>
        {collectorStatus?.last_polled_at && (
          <span className="last-polled">
            Last polled {formatRelativeTime(collectorStatus.last_polled_at)}
          </span>
        )}
        <button className="header-btn" onClick={() => setSelected([])} disabled={selected.length === 0} title="Clear selection">
          <IconDeselect size={13} />
        </button>
        <button className="header-btn" onClick={handleRefresh} disabled={refreshing} title="Refresh now">
          <IconRefresh size={13} className={refreshing ? "spinning" : ""} />
        </button>
      </div>
      {drives.length === 0
        ? <p className="status-scanning">Scanning…</p>
        : <div className="card-grid">
            {drives.map(d => (
              <DriveCard
                key={d.guid}
                drive={d}
                selected={selected.includes(d.guid)}
                onSelect={() => toggleSelect(d.guid)}
                footerSignals={settings?.footer_signals}
              />
            ))}
          </div>
      }
      <WorkspacePanel drives={drives} selected={selected} onToggleSelect={toggleSelect} />
    </div>
  )
}
