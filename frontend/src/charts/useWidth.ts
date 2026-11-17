import { useLayoutEffect, useState } from "react"
import type { RefObject } from "react"

const FALLBACK_WIDTH = 600   // before the first measure (and in jsdom, which has no layout)

/** The element's width in px, kept up to date as it resizes. The chart draws
 *  at this width rather than scaling a fixed viewBox, so it stays crisp in a
 *  wide workspace panel and a narrow card popover alike. */
export function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => { if (el.clientWidth > 0) setWidth(el.clientWidth) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
