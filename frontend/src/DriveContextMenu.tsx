import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Drive } from "./types"

interface Props {
  pos: { x: number; y: number }
  guids: string[]
  drives: Drive[]
  onClose: () => void
  onSetLocked: (guids: string[], locked: boolean) => void
  onRename?: (guids: string[], label: string | null) => void
}

const MENU_W = 180
const MENU_H = 160

export default function DriveContextMenu({ pos, guids, drives, onClose, onSetLocked, onRename }: Props) {
  const [confirmingUnlock, setConfirmingUnlock] = useState(false)
  const [renamingInMenu, setRenamingInMenu] = useState(false)
  const [renameInput, setRenameInput] = useState("")
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.addEventListener("click", onClose)
    window.addEventListener("scroll", onClose, true)
    return () => {
      document.removeEventListener("click", onClose)
      window.removeEventListener("scroll", onClose, true)
    }
  }, [onClose])

  useEffect(() => {
    if (renamingInMenu) renameInputRef.current?.focus()
  }, [renamingInMenu])

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

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setRenameInput(guids.length === 1 ? (selectedDrives[0]?.label ?? "") : "")
    setRenamingInMenu(true)
  }

  const commitRename = () => {
    const next = renameInput.trim() || null
    onRename?.(guids, next)
    onClose()
  }

  return createPortal(
    <div className="dc-popover dc-ctx-menu" style={style} onClick={e => e.stopPropagation()}>
      {renamingInMenu ? (
        <div className="dc-ctx-confirm">
          <span className="dc-ctx-confirm-msg">
            Rename {guids.length === 1 ? "drive" : `${guids.length} drives`}
          </span>
          <input
            ref={renameInputRef}
            className="dc-ctx-rename-input"
            value={renameInput}
            placeholder="Label…"
            onChange={e => setRenameInput(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === "Enter") commitRename()
              else if (e.key === "Escape") setRenamingInMenu(false)
            }}
          />
          <div className="dc-ctx-confirm-btns">
            <button className="dc-ctx-btn" onClick={e => { e.stopPropagation(); setRenamingInMenu(false) }}>Cancel</button>
            <button className="dc-ctx-btn dc-ctx-btn-primary" onClick={e => { e.stopPropagation(); commitRename() }}>Rename</button>
          </div>
        </div>
      ) : confirmingUnlock ? (
        <div className="dc-ctx-confirm">
          <span className="dc-ctx-confirm-msg">Unlock {guids.length === 1 ? "this drive" : "these drives"}?</span>
          <div className="dc-ctx-confirm-btns">
            <button className="dc-ctx-btn dc-ctx-btn-cancel" onClick={handleUnlockCancel}>Cancel</button>
            <button className="dc-ctx-btn dc-ctx-btn-confirm" onClick={handleUnlockConfirm}>Unlock</button>
          </div>
        </div>
      ) : (
        <>
          {guids.length > 1 && (
            <span className="dc-ctx-count">{guids.length} drives selected</span>
          )}
          <button className="dc-ctx-item" onClick={handleRenameClick}>
            Rename drive{guids.length > 1 ? "s" : ""}
          </button>
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
