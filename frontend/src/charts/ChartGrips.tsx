import { useRef } from "react"
import { TAP_SLOP } from "./chartTouch"

// Touch scrubbing for the charts (see chartTouch): grab the crosshair
// itself, or slide along the time axis. Both are invisible hit areas over
// the chart; a mouse never meets them (CSS hides them on hover devices).

/** The crosshair's grip: a 44px-wide strip centred on it, top to top +
 *  height, shown while a tapped reading is placed. Only it blocks scrolling
 *  (touch-action: none), so a drag starting anywhere else still scrolls.
 *  onDrag gets the client x the line should move to: the finger's x, less
 *  where on the strip it grabbed, so the line doesn't jump on grab. */
export function LineGrip({ x, top, height, onDrag }: { x: number; top: number; height: number; onDrag: (clientX: number) => void }) {
  const grab = useRef(0)
  return (
    <div
      className="chart-grip"
      style={{ left: x, top, height }}
      aria-hidden="true"
      onPointerDown={e => {
        // No compatibility mouse events either: a tap on the grip mustn't
        // move focus, which would blur the chart.
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        grab.current = e.clientX - (r.left + r.width / 2)
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={e => {
        e.stopPropagation()
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) onDrag(e.clientX - grab.current)
      }}
      onPointerUp={e => e.stopPropagation()}
      onPointerCancel={e => e.stopPropagation()}
    />
  )
}

/** The time axis as a scrub strip, from top to top + height. A drag that
 *  starts sideways scrubs (onTime with each client x); one that starts
 *  vertically is the browser's (touch-action: pan-y), so the page scrolls
 *  as anywhere else. A tap places the reading too. Touch only. */
export function AxisScrub({ top, height, onTime }: { top: number; height: number; onTime: (clientX: number) => void }) {
  const st = useRef<{ id: number; x: number; y: number; active: boolean } | null>(null)
  return (
    <div
      className="chart-axis-scrub"
      style={{ top, height }}
      aria-hidden="true"
      onPointerDown={e => {
        e.stopPropagation()
        st.current = e.pointerType === "touch" ? { id: e.pointerId, x: e.clientX, y: e.clientY, active: false } : null
      }}
      onPointerMove={e => {
        e.stopPropagation()
        const s = st.current
        if (!s || s.id !== e.pointerId) return
        if (!s.active) {
          const dx = Math.abs(e.clientX - s.x), dy = Math.abs(e.clientY - s.y)
          if (Math.hypot(dx, dy) <= TAP_SLOP) return
          if (dx <= dy) { st.current = null; return }    // vertical: the browser's, not ours
          s.active = true
          e.currentTarget.setPointerCapture?.(e.pointerId)
        }
        onTime(e.clientX)
      }}
      onPointerUp={e => {
        e.stopPropagation()
        const s = st.current
        st.current = null
        if (s && s.id === e.pointerId && !s.active) onTime(e.clientX)   // a tap
      }}
      onPointerCancel={e => { e.stopPropagation(); st.current = null }}
    />
  )
}
