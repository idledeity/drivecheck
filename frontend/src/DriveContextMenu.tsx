import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import type { Drive } from "./types"

interface Props {
  pos: { x: number; y: number }
  guids: string[]
  drives: Drive[]
  onClose: () => void
  onSetLocked: (guids: string[], locked: boolean) => void
}

const MENU_W = 180
const MENU_H = 120

export default function DriveContextMenu({ pos, guids, drives, onClose, onSetLocked }: Props) {
  const [confirmingUnlock, setConfirmingUnlock] = useState(false)

  useEffect(() => {
    document.addEventListener("click", onClose)
    window.addEventListener("scroll", onClose, true)
    return () => {
      document.removeEventListener("click", onClose)
      window.removeEventListener("scroll", onClose, true)
    }
  }, [onClose])

  const style = {
    top: Math.min(pos.y + 4, window.innerHeight - MENU_H - 8),
    left: Math.max(8, Math.min(pos.x, window.innerWidth - MENU_W - 8)),
  }

  const selectedDrives = drives.filter(d => guids.includes(d.guid))
  const anyUnlocked = selectedDrives.some(d => !d.locked)
  const anyLocked   = selectedDrives.some(d => d.locked)

  const handleLock = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSetLocked(guids.filter(g => !drives.find(d => d.guid === g)?.locked), true)
    onClose()
  }

  const handleUnlockRequest = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmingUnlock(true)
  }

  const handleUnlockConfirm = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSetLocked(guids.filter(g => drives.find(d => d.guid === g)?.locked), false)
    onClose()
  }

  const handleUnlockCancel = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmingUnlock(false)
  }

  return createPortal(
    <div className="dc-popover dc-ctx-menu" style={style} onClick={e => e.stopPropagation()}>
      {confirmingUnlock ? (
        <div className="dc-ctx-confirm">
          <span className="dc-ctx-confirm-msg">Unlock {guids.length === 1 ? "this drive" : "these drives"}?</span>
          <div className="dc-ctx-confirm-btns">
            <button className="dc-ctx-btn dc-ctx-btn-cancel" onClick={handleUnlockCancel}>Cancel</button>
            <button className="dc-ctx-btn dc-ctx-btn-confirm" onClick={handleUnlockConfirm}>Unlock</button>
          </div>
        </div>
      ) : (
        <>
          {anyUnlocked && (
            <button className="dc-ctx-item" onClick={handleLock}>
              Lock drive{guids.length > 1 ? "s" : ""}
            </button>
          )}
          {anyLocked && (
            <button className="dc-ctx-item dc-ctx-item-warn" onClick={handleUnlockRequest}>
              Unlock drive{guids.length > 1 ? "s" : ""}
            </button>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}
