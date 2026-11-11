import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import "./HoverReveal.css"

const MAX_WIDTH = 360  // px, matches .cfg-tooltip-bubble max-width

// Hover-to-reveal on a real mouse; tap-to-reveal on touch, dismissed by
// tapping anywhere else. Used both for the (i) tooltip icon and for
// revealing a config prop's raw key off its display name (Settings), and for
// Run Task parameter tooltips.
//
// Pointer events filtered to pointerType "mouse", not plain onMouseEnter/
// onMouseLeave: touch devices synthesize a compatibility mouseenter *and* a
// later mouseleave around a tap (to mimic hover for code that only knows
// about mouse events), which would silently re-close a tooltip a tap had
// just opened. Pointer events carry the real input source, so touch never
// reaches this hover path at all — it relies solely on onClick below.
export default function HoverReveal({ text, className, mono, children }: { text: string; className?: string; mono?: boolean; children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; placement: "above" | "below" } | null>(null)

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const margin = 12
    // Half the bubble's max width (HoverReveal.css), so a full-width bubble
    // centred on the anchor stays inside the viewport.
    const halfWidth = Math.min(MAX_WIDTH, window.innerWidth - 2 * margin) / 2
    const above = rect.top > 80
    setPos({
      top: above ? rect.top - 8 : rect.bottom + 8,
      left: Math.min(Math.max(rect.left + rect.width / 2, halfWidth + margin), window.innerWidth - halfWidth - margin),
      placement: above ? "above" : "below",
    })
  }
  const hide = () => setPos(null)

  useEffect(() => {
    if (!pos) return
    const onDocClick = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) hide()
    }
    // Deferred via setTimeout, not attached immediately: React flushes this
    // effect synchronously within the same click that opened the tooltip,
    // before that click's native bubble phase has finished reaching
    // document — an immediately-attached listener would catch its own
    // opening click and close the tooltip right back up.
    const id = window.setTimeout(() => document.addEventListener("click", onDocClick, true), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener("click", onDocClick, true)
    }
  }, [pos])

  return (
    <span
      className={`cfg-tooltip-anchor${className ? ` ${className}` : ""}`}
      ref={anchorRef}
      onPointerEnter={e => { if (e.pointerType === "mouse") show() }}
      onPointerLeave={e => { if (e.pointerType === "mouse") hide() }}
      // preventDefault: inside a <label>, a tap on the tooltip must not also
      // toggle the checkbox or focus the input the label belongs to.
      onClick={e => { e.preventDefault(); e.stopPropagation(); show() }}
    >
      {children}
      {pos && createPortal(
        <span
          className={`cfg-tooltip-bubble cfg-tooltip-bubble-${pos.placement}${mono ? " cfg-tooltip-bubble-mono" : ""}`}
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
