import { useEffect, useRef, useState } from "react"

/** Where an open popover sits: at the pointer, clamped inside the viewport. */
export type PopoverPos = { top: number; left: number }

// The popover's CSS max-width/max-height (kept in sync with DriveCard.css),
// used only to clamp away from viewport edges before the real size is known.
const POPOVER_W = 280
const POPOVER_H = 160
const MOVE_THRESHOLD = 4

/**
 * Popovers for several triggers on one surface, at most one open at a time.
 *
 * On a hover-capable device (a mouse) a trigger opens its popover only after
 * the pointer has been still on it for `delayMs`, like a native tooltip: any
 * further movement hides it and re-arms the delay. On a touch device a tap
 * toggles it instead ("pinned"), and the tap stops there rather than
 * reaching the surface underneath. A click anywhere else, or any scroll,
 * closes it.
 *
 * Triggers can nest (a pill inside a task bar): the innermost one under the
 * pointer wins, since each stops its mousemove from reaching the outer.
 *
 * Positioned at the pointer itself rather than the trigger's rect: anchoring
 * to an element's corner looks disconnected from the cursor when you enter
 * it further along. The caller renders the popover (usually through a portal
 * at `pos`, since a card clips overflow) and spreads `popoverProps` onto it.
 */
export function useHoverPopover<K extends string>({ supportsHover, delayMs }: { supportsHover: boolean; delayMs: number }) {
  const [open, setOpen] = useState<K | null>(null)
  const [pos, setPos] = useState<PopoverPos>({ top: 0, left: 0 })
  const pinnedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const lastRef = useRef<{ x: number; y: number; key: K } | null>(null)

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const positionAt = (x: number, y: number) => setPos({
    top: Math.min(y + 12, window.innerHeight - POPOVER_H - 8),
    left: Math.max(8, Math.min(x, window.innerWidth - POPOVER_W - 8)),
  })

  const close = () => {
    cancelTimer()
    pinnedRef.current = false
    setOpen(null)
  }

  // Entering a trigger always counts as movement, even by a pixel: it's a
  // different region. Within one, only a real move (past MOVE_THRESHOLD)
  // hides the popover and starts the delay again.
  const arm = (key: K, entering: boolean) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (pinnedRef.current || !supportsHover) return
    const { clientX: x, clientY: y } = e
    const last = lastRef.current
    const moved = entering || !last || last.key !== key || Math.hypot(x - last.x, y - last.y) > MOVE_THRESHOLD
    lastRef.current = { x, y, key }
    if (!moved) return
    cancelTimer()
    setOpen(p => pinnedRef.current ? p : null)
    timerRef.current = window.setTimeout(() => {
      positionAt(x, y)
      setOpen(key)
    }, delayMs)
  }

  const disarm = () => {
    cancelTimer()
    lastRef.current = null
    if (!pinnedRef.current) setOpen(null)
  }

  const toggle = (key: K) => (e: React.MouseEvent) => {
    e.stopPropagation()
    cancelTimer()
    setOpen(p => {
      if (p === key && pinnedRef.current) { pinnedRef.current = false; return null }
      pinnedRef.current = true
      positionAt(e.clientX, e.clientY)
      return key
    })
  }

  /** Handlers for the element that opens `key`'s popover. */
  const trigger = (key: K) => ({
    onMouseEnter: arm(key, true),
    onMouseMove: arm(key, false),
    onMouseLeave: disarm,
    onClick: supportsHover ? undefined : toggle(key),
  })

  // A click inside the popover mustn't count as "outside" and close it.
  const popoverProps = { onClick: (e: React.MouseEvent) => e.stopPropagation() }

  // Click outside or scroll closes it; a position:fixed popover would
  // otherwise drift away from its trigger. Triggers and the popover stop
  // their own clicks, so only a click elsewhere gets here.
  useEffect(() => {
    if (!open) return
    const onOutside = () => { pinnedRef.current = false; setOpen(null) }
    document.addEventListener("click", onOutside)
    window.addEventListener("scroll", onOutside, true)
    return () => {
      document.removeEventListener("click", onOutside)
      window.removeEventListener("scroll", onOutside, true)
    }
  }, [open])

  // A pending timer mustn't fire after unmount.
  useEffect(() => () => cancelTimer(), [])

  return { open, pos, trigger, popoverProps, close }
}
