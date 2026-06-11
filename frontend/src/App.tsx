import { useEffect, useState } from "react"
import { IconRefresh } from "@tabler/icons-react"
import DriveCard from "./DriveCard"
import WorkspacePanel from "./WorkspacePanel"
import type { CollectorStatus, Drive, Settings } from "./types"
import { formatRelativeTime } from "./format"
import "./App.css"

export default function App() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [selected, setSelected] = useState<string | null>(null)
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
    const id = setInterval(() => { loadDrives(); loadCollectorStatus() }, 30_000)
    return () => clearInterval(id)
  }, [])

  const handleRefresh = () => {
    setRefreshing(true)
    fetch("/api/drives/refresh", { method: "POST" })
      .then(() => Promise.all([loadDrives(), loadCollectorStatus()]))
      .catch(e => setError(String(e)))
      .finally(() => setRefreshing(false))
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
        <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing} title="Refresh now">
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
                selected={selected === d.guid}
                onSelect={() => setSelected(selected === d.guid ? null : d.guid)}
                footerSignals={settings?.footer_signals}
              />
            ))}
          </div>
      }
      <WorkspacePanel drives={drives} selected={selected} />
    </div>
  )
}
