import { useEffect, useState } from "react"

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

  if (error) return <p>Error: {error}</p>

  return (
    <div style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h2>Drives</h2>
      {drives.length === 0
        ? <p>Scanning...</p>
        : drives.map(d => (
            <div key={d.device} style={{ marginBottom: "0.5rem" }}>
              <strong>{d.device}</strong> — {d.serial}
            </div>
          ))
      }
    </div>
  )
}