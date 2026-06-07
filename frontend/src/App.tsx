import { useEffect, useState } from "react"
import "./App.css"

type Drive = {
  device: string
  serial: string
}

export default function App() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/drives")
      .then(r => r.json())
      .then(setDrives)
      .catch(e => setError(e.message))
  }, [])

  if (error) return <div className="status-error">Error: {error}</div>

  return (
    <div>
      <div className="page-label">
        drivecheck <span>/ drives</span>
      </div>
      <div className="drive-list">
        {drives.length === 0
          ? <p className="status-scanning">Scanning…</p>
          : drives.map(d => (
              <div key={d.device} className="drive-row">
                <span className="drive-device">{d.device}</span>
                <span className="drive-sep">—</span>
                <span className="drive-serial">{d.serial}</span>
              </div>
            ))
        }
      </div>
    </div>
  )
}
