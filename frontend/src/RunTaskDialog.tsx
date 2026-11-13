import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { IconX } from "@tabler/icons-react"
import type { Drive } from "./types"
import { useJobs } from "./jobsContext"
import RunTaskForm from "./RunTaskForm"
import "./RunTaskDialog.css"

interface Props {
  drives: Drive[]
  /** The drives the task runs on: the drive menu's drives. */
  guids: string[]
  onClose: () => void
}

/**
 * The Run Task form in a pop-up, opened from a drive's menu. Closes once a
 * task is queued; a refusal stays open with the form's error. Escape and a
 * backdrop click close it, but not while the form's own destructive-confirm
 * dialog (a portal of its own) is up: that dialog answers those itself.
 */
export default function RunTaskDialog({ drives, guids, onClose }: Props) {
  const { runOperation } = useJobs()
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => { cardRef.current?.focus() }, [])

  const run = async (g: string[], operation: string, params: Record<string, unknown>) => {
    const err = await runOperation(g, operation, params)
    if (err === null) onClose()
    return err
  }

  const count = guids.length
  return createPortal(
    <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div
        ref={cardRef}
        className="run-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rtd-title"
        tabIndex={-1}
        // Keys from inside this card only: the confirm dialog's are its own.
        onKeyDown={e => {
          if (e.key === "Escape" && cardRef.current?.contains(e.target as Node)) onClose()
        }}
      >
        <div className="rtd-header">
          <h3 id="rtd-title">Run task{count > 1 ? ` on ${count} drives` : ""}</h3>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <RunTaskForm drives={drives} guids={guids} onRun={run} />
      </div>
    </div>,
    document.body,
  )
}
