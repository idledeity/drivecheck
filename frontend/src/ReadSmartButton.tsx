import { useSmartRead } from "./smartReadContext"
import "./ReadSmartButton.css"

/** On a parked drive any SMART read loads the heads: one load/unload cycle. */
export const READ_SMART_TITLE = "Take a full SMART read now (on a drive with parked heads, this costs one load cycle)"

/**
 * "Read now": a full SMART read of these drives, now. Says "Reading…" while
 * any of them is being read (from here or anywhere else); onDone runs after
 * a read this button started comes back, e.g. to show its values.
 */
export default function ReadSmartButton({ guids, onDone, label = "Read now" }: {
  guids: string[]; onDone?: () => void; label?: string
}) {
  const { reading, readSmart } = useSmartRead()
  const busy = guids.some(g => reading.has(g))
  return (
    <button
      type="button"
      className="read-smart-btn"
      disabled={busy}
      title={READ_SMART_TITLE}
      onClick={e => {
        e.stopPropagation()
        void readSmart(guids).then(ok => { if (ok) onDone?.() })
      }}
    >
      {busy ? "Reading…" : label}
    </button>
  )
}
