import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { IconChevronRight } from "@tabler/icons-react"
import "./ContextSubmenu.css"

// How long the panel outlasts the pointer leaving the item and the panel:
// enough to cross a neighbouring item on a diagonal path into the panel.
const CLOSE_DELAY_MS = 250

/**
 * A menu item that opens a panel of more items beside the menu: to the
 * right, or to the left when there's no room on the right, or over part of
 * the menu when neither side has room (a phone); nudged up if it would run
 * off the bottom. Hover or a click opens it (a tap on touch); it
 * closes shortly after the pointer leaves, or with the menu. The panel is a
 * DOM child of the item, so clicks in it count as inside the menu, and
 * pointer moves into it count as staying on the item.
 */
export default function ContextSubmenu({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  useEffect(() => () => cancelClose(), [])

  // Placed once its size is known. Set on the element directly: this is
  // layout, not state, and needs to land before paint.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const menu = wrapRef.current?.closest(".dc-ctx-menu")
    if (!open || !panel || !menu) return
    const menuRect = menu.getBoundingClientRect()
    const { width, height, top } = panel.getBoundingClientRect()
    if (width === 0 && height === 0) return  // not laid out (or a test DOM)
    panel.classList.toggle("ctx-sub-left", menuRect.right + width > window.innerWidth - 8)
    const overflow = top + height - (window.innerHeight - 8)
    if (overflow > 0) panel.style.marginTop = `${-overflow}px`
    // On a narrow screen neither side may fit: slide it back on screen, over
    // part of the menu.
    const { left, right } = panel.getBoundingClientRect()
    const dx = left < 8 ? 8 - left : right > window.innerWidth - 8 ? window.innerWidth - 8 - right : 0
    panel.style.transform = dx ? `translateX(${dx}px)` : ""
  }, [open])

  return (
    <div
      ref={wrapRef}
      className="ctx-sub-wrap"
      onMouseEnter={() => { cancelClose(); setOpen(true) }}
      onMouseLeave={scheduleClose}
    >
      <button
        className={`dc-ctx-item ctx-sub-trigger${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        // Opens, never toggles: on touch a tap fires an emulated mouseenter
        // (which opens it) just before this click.
        onClick={e => { e.stopPropagation(); cancelClose(); setOpen(true) }}
      >
        <span>{label}</span>
        <IconChevronRight size={12} className="ctx-sub-chevron" />
      </button>
      {open && (
        <div ref={panelRef} className="dc-popover dc-ctx-menu ctx-sub" role="menu">
          {children}
        </div>
      )}
    </div>
  )
}
