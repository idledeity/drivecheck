import { useEffect, useLayoutEffect, useRef, useState } from "react"

/** Where an open popover sits: at the pointer, clamped inside the viewport. */
export type PopoverPos = { top: number; left: number }

// The popover's CSS max-width/max-height (kept in sync with DriveCard.css),
// used only to clamp away from viewport edges before the real size is known.
const POPOVER_W = 280
const POPOVER_H = 160
const MOVE_THRESHOLD = 4
// How long an open popover outlasts the pointer leaving it and its trigger.
const CLOSE_DELAY_MS = 300

/**
 * Popovers for several triggers on one surface, at most one open at a time.
 *
 * On a hover-capable device (a mouse) a trigger opens its popover only after
 * the pointer has been still on it for `delayMs`, like a native tooltip: any
 * movement before then re-arms the delay. Once open, the popover can be used:
 * it stays open while the pointer moves about its trigger or into the popover
 * itself, and closes `closeDelayMs` after the pointer has left both. That
 * grace period is what lets the pointer cross the gap, or another trigger,
 * on its way into the popover.
 *
 * On a touch device a tap toggles it instead ("pinned"), and the tap stops
 * there rather than reaching the surface underneath. A click anywhere else,
 * or a scroll outside the popover, closes it.
 *
 * Triggers can nest (a pill inside a task bar): the innermost one under the
 * pointer wins, since each stops its mousemove from reaching the outer.
 *
 * Positioned at the pointer itself rather than the trigger's rect: anchoring
 * to an element's corner looks disconnected from the cursor when you enter
 * it further along. If the popover, once rendered, would run off the bottom
 * it flips above the pointer. The caller renders the popover (usually through
 * a portal at `pos`, since a card clips overflow) and spreads `popoverProps`
 * onto it.
 */
export function useHoverPopover<K extends string>({ supportsHover, delayMs, closeDelayMs = CLOSE_DELAY_MS }: { supportsHover: boolean; delayMs: number; closeDelayMs?: number }) {
  const [open, setOpenState] = useState<K | null>(null)
  const [pos, setPos] = useState<PopoverPos>({ top: 0, left: 0 })
  const openRef = useRef<K | null>(null)
  const pinnedRef = useRef(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const lastRef = useRef<{ x: number; y: number; key: K } | null>(null)
  const anchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // The handlers read openRef rather than `open`, which would be stale
  // inside a timer started before the last render.
  const setOpen = (key: K | null) => {
    openRef.current = key
    setOpenState(key)
  }

  const cancelOpen = () => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  // Not restarted by later calls: the grace period runs from the moment the
  // pointer first left, however much it moves about afterwards.
  const scheduleClose = () => {
    if (pinnedRef.current || openRef.current === null || closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(null)
    }, closeDelayMs)
  }

  const positionAt = (x: number, y: number) => {
    anchorRef.current = { x, y }
    setPos({
      top: Math.min(y + 12, window.innerHeight - POPOVER_H - 8),
      left: Math.max(8, Math.min(x, window.innerWidth - POPOVER_W - 8)),
    })
  }

  const close = () => {
    cancelOpen()
    cancelClose()
    pinnedRef.current = false
    setOpen(null)
  }

  // Entering a trigger always counts as movement, even by a pixel: it's a
  // different region. Within one, only a real move (past MOVE_THRESHOLD)
  // starts the delay again.
  const arm = (key: K, entering: boolean) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (pinnedRef.current || !supportsHover) return
    // Back on (or still on) the trigger of the open popover: keep it.
    if (openRef.current === key) {
      cancelClose()
      lastRef.current = null
      return
    }
    const { clientX: x, clientY: y } = e
    const last = lastRef.current
    const moved = entering || !last || last.key !== key || Math.hypot(x - last.x, y - last.y) > MOVE_THRESHOLD
    lastRef.current = { x, y, key }
    if (!moved) return
    cancelOpen()
    // Another popover is open: the pointer may only be passing through on
    // its way into it, so close that one on the grace timer, not at once.
    scheduleClose()
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      cancelClose()
      positionAt(x, y)
      setOpen(key)
    }, delayMs)
  }

  const disarm = () => {
    cancelOpen()
    lastRef.current = null
    scheduleClose()
  }

  const toggle = (key: K) => (e: React.MouseEvent) => {
    e.stopPropagation()
    cancelOpen()
    cancelClose()
    if (openRef.current === key && pinnedRef.current) {
      pinnedRef.current = false
      setOpen(null)
      return
    }
    pinnedRef.current = true
    positionAt(e.clientX, e.clientY)
    setOpen(key)
  }

  /** Handlers for the element that opens `key`'s popover. */
  const trigger = (key: K) => ({
    onMouseEnter: arm(key, true),
    onMouseLeave: disarm,
    onMouseMove: arm(key, false),
    onClick: supportsHover ? undefined : toggle(key),
  })

  // A click inside the popover mustn't count as "outside" and close it, and
  // the popover is usually a React child of the surface (through a portal),
  // so its events would otherwise reach the surface's own handlers too:
  // selecting it, long-press, or the surface's context menu in place of the
  // browser's (which is wanted in here, to copy text).
  const popoverProps = {
    ref: popoverRef,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onMouseEnter: () => { cancelOpen(); cancelClose() },
    onMouseLeave: () => scheduleClose(),
  }

  // The real size is only known once rendered: flip above the pointer when
  // it would run off the bottom, and pull it in from the right edge. Done on
  // the element directly; `pos` stays the first estimate.
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!open || !el) return
    const { width, height } = el.getBoundingClientRect()
    if (width === 0 && height === 0) return  // not laid out (or a test DOM)
    const { x, y } = anchorRef.current
    if (y + 12 + height > window.innerHeight - 8) {
      // Above the pointer if it fits there, else as low as it can go.
      const above = y - 12 - height
      el.style.top = `${above >= 8 ? above : Math.max(8, window.innerHeight - 8 - height)}px`
    }
    if (x + width > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - width - 8)}px`
    }
  }, [open, pos])

  // Click outside or scroll closes it; a position:fixed popover would
  // otherwise drift away from its trigger. Triggers and the popover stop
  // their own clicks, so only a click elsewhere gets here. Scrolling the
  // popover's own content is fine.
  useEffect(() => {
    if (!open) return
    const onOutside = () => {
      pinnedRef.current = false
      cancelClose()
      openRef.current = null
      setOpenState(null)
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && popoverRef.current?.contains(e.target)) return
      onOutside()
    }
    document.addEventListener("click", onOutside)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("click", onOutside)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [open])

  // A pending timer mustn't fire after unmount.
  useEffect(() => () => { cancelOpen(); cancelClose() }, [])

  return { open, pos, trigger, popoverProps, close }
}
