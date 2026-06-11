import { useEffect, useState } from "react"
import type { Drive, RawSnapshot, SmartAttributeRow } from "./types"

interface Props {
  drives: Drive[]
  selectedGuid: string | null
}

const SEVERITY_RANK: Record<SmartAttributeRow["status"], number> = { crit: 0, warn: 1, ok: 2 }

export default function SmartAttributesPanel({ drives, selectedGuid }: Props) {
  const [viewedGuid, setViewedGuid] = useState<string | null>(selectedGuid)
  const [snapshot, setSnapshot] = useState<RawSnapshot | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    setViewedGuid(selectedGuid)
  }, [selectedGuid])

  useEffect(() => {
    if (!viewedGuid) return
    setSnapshot(null)
    setNotFound(false)
    fetch(`/api/drives/${viewedGuid}/raw/latest`)
      .then(r => {
        if (r.status === 404) {
          setNotFound(true)
          return null
        }
        return r.json()
      })
      .then(data => { if (data) setSnapshot(data) })
      .catch(() => setNotFound(true))
  }, [viewedGuid])

  const rows = [...(snapshot?.raw.smart_attributes ?? [])]
    .sort((a, b) => SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status])

  return (
    <div className="smart-panel">
      <div className="drive-switcher">
        {drives.map(d => (
          <button
            key={d.guid}
            className={`drive-chip${d.guid === viewedGuid ? " active" : ""}`}
            onClick={() => setViewedGuid(d.guid)}
          >
            {d.model ?? d.device}
          </button>
        ))}
      </div>

      {!viewedGuid && <p className="smart-empty">Select a drive to view SMART attributes.</p>}
      {viewedGuid && notFound && <p className="smart-empty">No SMART data yet — waiting for next poll.</p>}
      {viewedGuid && !notFound && snapshot && rows.length === 0 && (
        <p className="smart-empty">No attribute data available for this drive.</p>
      )}
      {rows.length > 0 && (
        <div className="attr-list">
          {rows.map(row => (
            <div key={row.key} className="attr-row">
              <div className="attr-main">
                <span className="attr-label">{row.label}</span>
                <span className={`attr-value attr-${row.status}`}>{row.value}</span>
              </div>
              {row.detail && <div className="attr-detail">{row.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
