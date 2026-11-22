import { useEffect, useRef } from "react"
import type { PointerEvent } from "react"

// Touch handling shared by the charts. On a touch screen a chart never takes
// a drag: every drag scrolls the page. A tap places the reading. Scrubbing
// is by grabbing the placed crosshair itself, or sliding along the time axis
// (ChartGrips). Mouse and pen keep plain hovering.

/** Movement (px) past which a touch is a drag (a scroll), not a tap. */
export const TAP_SLOP = 8
/** Charts mark their root with this attribute (data-chart=""), so a tap on
 *  any chart isn't "outside" (it places the reading there instead). */
const CHART_ATTR = "data-chart"
/** Every open popover carries this (useHoverPopover). */
const POPOVER = "[data-popover]"

interface TouchStart { id: number; x: number; y: number }

const moved = (s: TouchStart, e: { clientX: number; clientY: number }) =>
  Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP

/** Pointer handlers that call onTap for a touch that lifts without moving.
 *  A scroll ends in pointercancel (the browser took the gesture), or moves
 *  past the slop first; neither is a tap. Mouse and pen are ignored. */
export function useTouchTap(onTap: (e: PointerEvent<Element>) => void) {
  const start = useRef<TouchStart | null>(null)
  return {
    down: (e: PointerEvent<Element>) => {
      if (e.pointerType === "touch") start.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    },
    move: (e: PointerEvent<Element>) => {
      const s = start.current
      if (s && s.id === e.pointerId && moved(s, e)) start.current = null
    },
    up: (e: PointerEvent<Element>) => {
      const s = start.current
      start.current = null
      if (s && s.id === e.pointerId && !moved(s, e)) onTap(e)
    },
    cancel: () => { start.current = null },
  }
}

/** While active, a touch tap anywhere outside every chart calls onOutside
 *  (keep it stable). Taps, not touches: starting a scroll elsewhere leaves
 *  the reading alone. A tap in a popover (one opened from the readings,
 *  e.g. the jobs list), or one that closes a popover, isn't one either. */
export function useTapOutside(active: boolean, onOutside: () => void) {
  useEffect(() => {
    if (!active) return
    let start: TouchStart | null = null
    const down = (e: globalThis.PointerEvent) => {
      const closesPopover = document.querySelector(POPOVER) !== null
      start = e.pointerType === "touch" && !closesPopover ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null
    }
    const up = (e: globalThis.PointerEvent) => {
      const s = start
      start = null
      if (!s || s.id !== e.pointerId || moved(s, e)) return
      const target = e.target instanceof Element ? e.target : null
      if (!target?.closest(`[${CHART_ATTR}]`)) onOutside()
    }
    const cancel = () => { start = null }
    document.addEventListener("pointerdown", down)
    document.addEventListener("pointerup", up)
    document.addEventListener("pointercancel", cancel)
    return () => {
      document.removeEventListener("pointerdown", down)
      document.removeEventListener("pointerup", up)
      document.removeEventListener("pointercancel", cancel)
    }
  }, [active, onOutside])
}
