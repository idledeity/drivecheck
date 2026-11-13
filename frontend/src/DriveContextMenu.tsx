import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Drive, Job } from "./types"
import { useJobs } from "./jobsContext"
import { useConfirm } from "./confirmContext"
import { jobCancelConfirmation } from "./jobCancelConfirmation"
import { DRIVE_COPY_FIELDS, driveCopyText, type DriveCopyField } from "./driveCopyText"
import { copyText } from "./clipboard"
import ContextSubmenu from "./ContextSubmenu"

interface Props {
  pos: { x: number; y: number }
  guids: string[]
  drives: Drive[]
  onClose: () => void
  onSetLocked: (guids: string[], locked: boolean) => void
  onRename?: (guids: string[], label: string | null) => void
  /** The running (or next queued) job on each of the menu's drives that has one. */
  activeJobs?: Job[]
}

const MENU_W = 180
// A rough height for keeping it off the bottom edge.
const MENU_H = 180
// How long a copy item says "Copied" before the menu closes itself.
const COPIED_MS = 600

export default function DriveContextMenu({ pos, guids, drives, onClose, onSetLocked, onRename, activeJobs = [] }: Props) {
  const { cancelJob } = useJobs()
  const confirm = useConfirm()
  const [confirmingUnlock, setConfirmingUnlock] = useState(false)
  const [renamingInMenu, setRenamingInMenu] = useState(false)
  const [renameInput, setRenameInput] = useState("")
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [copyResult, setCopyResult] = useState<{ key: DriveCopyField["key"]; ok: boolean } | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  useEffect(() => () => { if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current) }, [])

  // A page scroll closes it (it's position:fixed and would drift from the
  // card), but not a scroll of the menu itself on a very short screen.
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener("click", onClose)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("click", onClose)
      window.removeEventListener("scroll", onScroll, true)
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

  // Only the job each drive is on now; anything queued behind it stays.
  // The menu closes first: the question is the confirm pop-up's, not ours.
  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClose()
    const jobs = activeJobs
    const cancelAll = () => jobs.forEach(j => cancelJob(j.id))
    const request = jobCancelConfirmation(jobs, drives)
    if (!request) { cancelAll(); return }
    void confirm(request).then(ok => { if (ok) cancelAll() })
  }

  // Says whether it worked in place of the item's text, then closes.
  const handleCopy = (field: DriveCopyField, text: string) => async (e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await copyText(text)
    setCopyResult({ key: field.key, ok })
    closeTimerRef.current = window.setTimeout(onClose, COPIED_MS)
  }

  const copyItems = DRIVE_COPY_FIELDS
    .map(field => ({ field, text: driveCopyText(field, selectedDrives) }))
    .filter((item): item is { field: DriveCopyField; text: string } => item.text !== null)

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
    <div ref={menuRef} className="dc-popover dc-ctx-menu" style={style} onClick={e => e.stopPropagation()}>
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
          {activeJobs.length > 0 && (
            <button className="dc-ctx-item dc-ctx-item-danger" onClick={handleCancel}>
              {activeJobs.length === 1 ? "Cancel task" : `Cancel ${activeJobs.length} tasks`}
            </button>
          )}
          {copyItems.length > 0 && (
            <ContextSubmenu label="Copy">
              {guids.length > 1 && <span className="ctx-sub-note">One line per drive</span>}
              {copyItems.map(({ field, text }) => (
                <button key={field.key} className="dc-ctx-item" onClick={handleCopy(field, text)} title={text}>
                  {copyResult?.key === field.key ? (copyResult.ok ? "Copied" : "Couldn't copy") : field.label}
                </button>
              ))}
            </ContextSubmenu>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}
