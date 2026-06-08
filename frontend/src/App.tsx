import { useEffect, useState } from "react"
import DriveCard from "./DriveCard"
import type { Drive } from "./types"
import "./App.css"

export default function App() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = () =>
      fetch("/api/drives")
        .then(r => r.json())
        .then(setDrives)
        .catch(e => setError(String(e)))

    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  if (error) return <div className="status-error">Error: {error}</div>

  return (
    <div>
      <div className="page-label">drivecheck <span>/ drives</span></div>
      {drives.length === 0
        ? <p className="status-scanning">Scanning…</p>
        : <div className="card-grid">
            {drives.map(d => (
              <DriveCard
                key={d.guid}
                drive={d}
                selected={selected === d.guid}
                onSelect={() => setSelected(selected === d.guid ? null : d.guid)}
              />
            ))}
          </div>
      }
    </div>
  )
}
