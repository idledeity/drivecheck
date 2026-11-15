import { useEffect, useState } from "react"
import type { Drive, RawSnapshot, SmartAttributeRow } from "./types"
import { DriveChipHeader } from "./DriveChip"
import AsOf from "./AsOf"

interface Props {
  drives: Drive[]
  selectedGuids: string[]
}

const SEVERITY_RANK: Record<SmartAttributeRow["status"], number> = { crit: 0, warn: 1, ok: 2 }

export default function SmartAttributesPanel({ drives, selectedGuids }: Props) {
  return (
    <div className="smart-panel">
      {selectedGuids.length === 0 && <p className="smart-empty">Select one or more drives to view SMART attributes.</p>}

      {selectedGuids.map(guid => {
        const drive = drives.find(d => d.guid === guid)
        return (
          <div key={guid} className="smart-drive-section">
            <DriveHeader drive={drive} />
            <DriveAttributes key={guid} guid={guid} refreshKey={drive?.last_polled_at} staleAfterS={drive?.stale_after_s.smart} />
          </div>
        )
      })}
    </div>
  )
}

function DriveHeader({ drive }: { drive?: Drive }) {
  return <DriveChipHeader drive={drive} className="smart-drive-header" />
}

/**
 * A drive's latest saved full SMART read (attributes and the drive's own
 * self-test log), with when it was taken. Fetched again whenever refreshKey
 * changes (the drive's last poll time), keeping the old one on screen meanwhile.
 * Callers key it by guid, so another drive starts blank rather than showing
 * the last one's report while it loads.
 */
export function DriveAttributes({ guid, refreshKey, staleAfterS }: { guid: string; refreshKey?: string | null; staleAfterS?: number }) {
  const [snapshot, setSnapshot] = useState<RawSnapshot | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    fetch(`/api/drives/${guid}/raw/latest`)
      .then(r => {
        if (r.status === 404) {
          setNotFound(true)
          return null
        }
        return r.json()
      })
      .then(data => {
        if (!data) return
        setNotFound(false)
        setSnapshot(data)
      })
      .catch(() => setNotFound(true))
  }, [guid, refreshKey])

  if (notFound) return <p className="smart-empty">No SMART data yet — waiting for next poll.</p>

  const rows = [...(snapshot?.raw.smart_attributes ?? [])]
    .sort((a, b) => SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status])
  const testLog = snapshot?.raw.self_test_log ?? []

  if (snapshot && rows.length === 0 && testLog.length === 0) {
    return <p className="smart-empty">No attribute data available for this drive.</p>
  }

  return (
    <>
      {snapshot?.captured_at && (
        <p className="smart-asof">
          Full SMART read <AsOf at={snapshot.captured_at} staleAfterS={staleAfterS} />
        </p>
      )}
      {rows.length > 0 && (
        <AttrList rows={rows} />
      )}
      {testLog.length > 0 && (
        <>
          {/* Drive's own onboard self-test log — independent of, and may predate,
              any test DriveCheck itself has run (see History tab for those). */}
          <h3 className="smart-section-title">Self-Test History (drive log)</h3>
          <AttrList rows={testLog} />
        </>
      )}
    </>
  )
}

function AttrList({ rows }: { rows: SmartAttributeRow[] }) {
  return (
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
  )
}
