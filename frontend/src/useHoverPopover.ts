import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

/** Whether the primary pointer can hover (a mouse), not touch: false on a
 *  touchscreen laptop while touch is driving, even with a mouse attached.
 *  Read once where it's used; switching input mid-session needn't react. */
export const canHover = () => window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false

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
 * On a touch device a tap opens it instead ("pinned"), and the tap stops
 * there rather than reaching the surface underneath. A click anywhere else
 * (another trigger included) only closes it, and a scroll outside the
 * popover closes it too.
 *
 * Triggers can nest (a pill inside a task bar): the innermost one under the
 * pointer wins, since each stops its mousemove from reaching the outer.
 *
 * While `disabled` (e.g. a menu is open over the surface) triggers do
 * nothing; the caller closes any open popover with `close()` first.
 *
 * Positioned at the pointer itself rather than the trigger's rect: anchoring
 * to an element's corner looks disconnected from the cursor when you enter
 * it further along. If the popover, once rendered, would run off the bottom
 * it flips above the pointer. The caller renders the popover (usually through
 * a portal at `pos`, since a card clips overflow) and spreads `popoverProps`
 * onto it.
 */
export function useHoverPopover<K extends string>({ supportsHover, delayMs, closeDelayMs = CLOSE_DELAY_MS, disabled = false }: { supportsHover: boolean; delayMs: number; closeDelayMs?: number; disabled?: boolean }) {
  const [open, setOpenState] = useState<K | null>(null)
  const [pos, setPos] = useState<PopoverPos>({ top: 0, left: 0 })
  const openRef = useRef<K | null>(null)
  const pinnedRef = useRef(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const lastRef = useRef<{ x: number; y: number; key: K } | null>(null)
  const anchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // Tags this hook's triggers, to tell them from another surface's (another
  // drive card has its own hook) when one is tapped.
  const id = useId()

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
    if (pinnedRef.current || !supportsHover || disabled) return
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
    if (disabled) return
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
    "data-popover-trigger": id,
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
    "data-popover": "",
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onMouseEnter: () => { cancelOpen(); cancelClose() },
    onMouseLeave: () => scheduleClose(),
  }

  // The real size is only known once rendered: flip above the pointer when
  // it would run off the bottom, and pull it in from the right edge. Done on
  // the element directly; `pos` stays the first estimate. Placed again
  // whenever its size changes: content that loads after opening (a history
  // chart replacing "Loading…") can make it much taller.
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!open || !el) return
    const place = () => {
      const { width, height } = el.getBoundingClientRect()
      if (width === 0 && height === 0) return  // not laid out (or a test DOM)
      const { x, y } = anchorRef.current
      const below = y + 12
      if (below + height > window.innerHeight - 8) {
        // Above the pointer if it fits there, else as low as it can go.
        const above = y - 12 - height
        el.style.top = `${above >= 8 ? above : Math.max(8, window.innerHeight - 8 - height)}px`
      } else {
        el.style.top = `${Math.min(below, window.innerHeight - 8 - height)}px`
      }
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`
    }
    place()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, pos])

  // A click outside closes it, and that's all the click does: caught on the
  // way down (capture, at document) and stopped there, so it never selects
  // what's under it or opens another popover — the user was dismissing this
  // one. Scroll closes it too; a position:fixed popover would otherwise drift
  // away from its trigger.
  //
  // Not outside: this popover; one opened from inside it (portalled after it
  // in the DOM, e.g. a chart's job list in a card's trend popover), which
  // handles its own clicks; and a modal dialog (a confirm opened from in
  // here), which closes this one but must still get its click. With a mouse,
  // a click on this popover's own trigger goes through as well: the popover
  // opened on hover, and the click is meant for what's under it (selecting
  // the card). Scrolling any popover's own content is fine.
  useEffect(() => {
    if (!open) return
    const dismiss = () => {
      pinnedRef.current = false
      cancelClose()
      openRef.current = null
      setOpenState(null)
    }
    const onClick = (e: MouseEvent) => {
      const own = popoverRef.current
      if (!own || !(e.target instanceof Element)) return
      if (own.contains(e.target)) return
      const inside = e.target.closest("[data-popover]")
      if (inside && own.compareDocumentPosition(inside) & Node.DOCUMENT_POSITION_FOLLOWING) return
      if (e.target.closest('[aria-modal="true"]')) { dismiss(); return }
      if (supportsHover && e.target.closest("[data-popover-trigger]")?.getAttribute("data-popover-trigger") === id) return
      e.preventDefault()
      e.stopPropagation()
      dismiss()
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Element && e.target.closest("[data-popover]")) return
      dismiss()
    }
    document.addEventListener("click", onClick, true)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("click", onClick, true)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [open, id, supportsHover])

  // A pending timer mustn't fire after unmount.
  useEffect(() => () => { cancelOpen(); cancelClose() }, [])

  return { open, pos, trigger, popoverProps, close }
}
