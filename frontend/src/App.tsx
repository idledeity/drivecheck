import { useEffect, useState } from "react"
import DriveCard from "./DriveCard"
import GridControls from "./GridControls"
import WorkspacePanel from "./WorkspacePanel"
import type { Drive, Settings } from "./types"
import "./App.css"

export default function App() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(setSettings).catch(() => {})
  }, [])

  const loadDrives = () =>
    fetch("/api/drives")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => { setDrives(data); setError(null) })
      .catch(() => setError("Backend unavailable — retrying…"))

  useEffect(() => {
    loadDrives()
    // /api/drives is an in-memory read (no subprocess calls), so poll it
    // faster than the collector's 10s vitals cadence to keep the live
    // temp/IO readings on each DriveCard feeling current.
    const id = setInterval(loadDrives, 2_000)
    return () => clearInterval(id)
  }, [])

  const toggleSelect = (guid: string) => {
    setSelected(prev => prev.includes(guid) ? prev.filter(g => g !== guid) : [...prev, guid])
  }

  const handleSelectAll = () => setSelected(drives.map(d => d.guid))

  const handleUnselectAll = () => setSelected([])

  const handleProbe = () =>
    fetch("/api/drives/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guids: selected.length > 0 ? selected : undefined }),
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return loadDrives()
      })
      .catch(() => setError("Backend unavailable — retrying…"))

  const handleScan = () =>
    fetch("/api/drives/scan", { method: "POST" })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return loadDrives()
      })
      .catch(() => setError("Backend unavailable — retrying…"))

  const handleLabelChange = (guid: string, label: string | null) => {
    setDrives(prev => prev.map(d => d.guid === guid ? { ...d, label } : d))
    fetch(`/api/drives/${guid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    }).catch(() => setError("Backend unavailable — retrying…"))
  }

  return (
    <div>
      {error && <div className="status-error">{error}</div>}
      <div className="page-label">
        drivecheck
        <GridControls
          drives={drives}
          selected={selected}
          onSelectAll={handleSelectAll}
          onUnselectAll={handleUnselectAll}
          onProbe={handleProbe}
          onScan={handleScan}
        />
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
                onLabelChange={handleLabelChange}
              />
            ))}
          </div>
      }
      <WorkspacePanel drives={drives} selected={selected} onToggleSelect={toggleSelect} />
    </div>
  )
}
