import { useCallback, useEffect, useRef, useState } from "react"
import DriveCard from "./DriveCard"
import DriveContextMenu from "./DriveContextMenu"
import GridControls from "./GridControls"
import SettingsOverlay from "./SettingsOverlay"
import WorkspacePanel from "./WorkspacePanel"
import type { Drive, Job, Settings } from "./types"
import "./App.css"

export default function App() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const anchorRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [contextMenu, setContextMenu] = useState<{ pos: { x: number; y: number }; guids: string[] } | null>(null)

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const handleDriveContextMenu = (guid: string, pos: { x: number; y: number }) => {
    if (selected.includes(guid) && selected.length > 1) {
      setContextMenu({ pos, guids: selected })
    } else {
      setSelected([guid])
      anchorRef.current = guid
      setContextMenu({ pos, guids: [guid] })
    }
  }
  // Persisted to sessionStorage so a refresh while Settings is open doesn't
  // silently drop back to the main view.
  const [settingsOpen, setSettingsOpen] = useState(() => sessionStorage.getItem("drivecheck.settingsOpen") === "1")

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(setSettings).catch(() => {})
  }, [])

  useEffect(() => {
    if (settingsOpen) sessionStorage.setItem("drivecheck.settingsOpen", "1")
    else sessionStorage.removeItem("drivecheck.settingsOpen")
  }, [settingsOpen])

  const loadDrives = () =>
    fetch("/api/drives")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => { setDrives(data); setError(null) })
      .catch(() => setError("Backend unavailable — retrying…"))

  const loadJobs = () =>
    fetch("/api/jobs")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setJobs)
      .catch(() => {})

  useEffect(() => {
    loadDrives()
    loadJobs()
    // /api/drives is an in-memory read (no subprocess calls), so poll it
    // faster than the collector's 10s vitals cadence to keep the live
    // temp/IO readings on each DriveCard feeling current. /api/jobs is
    // likewise an in-memory read, polled on the same cadence for live
    // progress in the Queue tab and DriveCard task zones.
    const id = setInterval(() => { loadDrives(); loadJobs() }, 2_000)
    return () => clearInterval(id)
  }, [])

  const cancelJob = (jobId: string) =>
    fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return loadJobs()
      })
      .catch(() => setError("Backend unavailable — retrying…"))

  const runOperation = (guids: string[], operation: string, params: Record<string, unknown>) =>
    fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guids, operation, params }),
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return loadJobs()
      })
      .catch(() => setError("Backend unavailable — retrying…"))

  const handleSelect = (guid: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected(prev => prev.includes(guid) ? prev.filter(g => g !== guid) : [...prev, guid])
    } else if (e.shiftKey && anchorRef.current) {
      const guids = drives.map(d => d.guid)
      const anchorIdx = guids.indexOf(anchorRef.current)
      const clickIdx = guids.indexOf(guid)
      if (anchorIdx === -1) {
        setSelected([guid])
        anchorRef.current = guid
      } else {
        const lo = Math.min(anchorIdx, clickIdx)
        const hi = Math.max(anchorIdx, clickIdx)
        setSelected(guids.slice(lo, hi + 1))
      }
    } else {
      setSelected([guid])
      anchorRef.current = guid
    }
  }

  const handleSelectToggle = (guid: string) => {
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

  const handleSetLocked = (guids: string[], locked: boolean) => {
    setDrives(prev => prev.map(d => guids.includes(d.guid) ? { ...d, locked } : d))
    guids.forEach(guid =>
      fetch(`/api/drives/${guid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked }),
      }).catch(() => setError("Backend unavailable — retrying…"))
    )
  }

  // The job a DriveCard's task zone should reflect: the drive's running job,
  // or else its earliest-queued one (jobs are returned in creation order).
  const activeJobForDrive = (guid: string): Job | undefined =>
    jobs.find(j => j.drive_guid === guid && j.status === "running")
      ?? jobs.find(j => j.drive_guid === guid && j.status === "queued")

  const queuedJobsForDrive = (guid: string): Job[] =>
    jobs.filter(j => j.drive_guid === guid && j.status === "queued")

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
          onOpenSettings={() => setSettingsOpen(true)}
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
                onSelect={(e) => handleSelect(d.guid, e)}
                onContextMenu={handleDriveContextMenu}
                onSelectToggle={() => handleSelectToggle(d.guid)}
                footerSignals={settings?.footer_signals}
                onLabelChange={handleLabelChange}
                job={activeJobForDrive(d.guid)}
                queuedJobs={queuedJobsForDrive(d.guid)}
              />
            ))}
          </div>
      }
      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}
      {contextMenu && <DriveContextMenu pos={contextMenu.pos} guids={contextMenu.guids} drives={drives} onClose={closeContextMenu} onSetLocked={handleSetLocked} />}
      <WorkspacePanel
        drives={drives}
        selected={selected}
        jobs={jobs}
        onCancelJob={cancelJob}
        onRunOperation={runOperation}
      />
    </div>
  )
}
