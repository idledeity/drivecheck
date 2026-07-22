import { useEffect } from "react"
import { createPortal } from "react-dom"

interface Props {
  pos: { x: number; y: number }
  guids: string[]
  onClose: () => void
}

const MENU_W = 200
const MENU_H = 80

export default function DriveContextMenu({ pos, guids, onClose }: Props) {
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

  return createPortal(
    <div className="dc-popover dc-ctx-menu" style={style} onClick={e => e.stopPropagation()}>
      <span className="dc-ctx-placeholder">
        {guids.length === 1 ? "1 drive" : `${guids.length} drives selected`}
      </span>
    </div>,
    document.body,
  )
}
