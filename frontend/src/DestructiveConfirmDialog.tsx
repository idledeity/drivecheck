import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { IconAlertTriangle } from "@tabler/icons-react"
import { formatCapacity } from "./format"
import Serial from "./Serial"
import type { Drive, OperationInfo } from "./types"
import "./DestructiveConfirmDialog.css"

interface Props {
  operation: OperationInfo
  targets: Drive[]
  onConfirm: () => void
  onCancel: () => void
}

// Last stop before a destructive operation is dispatched: names every target
// by what identifies it physically (model, serial, device path, capacity),
// since a label or "3 drives" is easy to misread. With more than one target
// the drive count has to be typed, so a stray Enter can't confirm a mass erase.
// Uses the shared confirm-scrim / confirm-card styles (SettingsOverlay.css).
export default function DestructiveConfirmDialog({ operation, targets, onConfirm, onCancel }: Props) {
  const needsTypedCount = targets.length > 1
  const [typed, setTyped] = useState("")
  const confirmed = !needsTypedCount || typed.trim() === String(targets.length)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  return createPortal(
    <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="confirm-card dcf-card" role="alertdialog" aria-modal="true" aria-labelledby="dcf-title">
        <p id="dcf-title" className="dcf-title">
          <IconAlertTriangle size={15} className="dcf-icon" />
          {operation.name} destroys all data on {targets.length === 1 ? "this drive" : `these ${targets.length} drives`}
        </p>
        <table className="dcf-targets">
          <thead>
            <tr><th>Drive</th><th>Serial</th><th>Device</th><th>Capacity</th></tr>
          </thead>
          <tbody>
            {targets.map(d => (
              <tr key={d.guid}>
                <td>
                  {d.label && <span className="dcf-label">{d.label}</span>}
                  <span className="dcf-model">{d.model ?? "Unknown model"}</span>
                </td>
                <td>{d.serial ? <Serial value={d.serial} /> : "—"}</td>
                <td className="dcf-device">{d.block_device ?? d.device}</td>
                <td>{formatCapacity(d.capacity_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {needsTypedCount && (
          <label className="dcf-typed">
            Type <b>{targets.length}</b> to confirm the number of drives
            <input
              autoFocus
              inputMode="numeric"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && confirmed) onConfirm() }}
              aria-label="Number of drives"
            />
          </label>
        )}
        <div className="restart-confirm-actions">
          <button className="text-link-btn" onClick={onCancel} autoFocus={!needsTypedCount}>Cancel</button>
          <button className="tinted-btn tint-re" onClick={onConfirm} disabled={!confirmed}>
            Run {operation.name}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
