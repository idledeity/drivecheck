import { useEffect, useRef, useState } from "react"

// Tracks whether an element's content actually overflows its own box, so a
// scrollable row's edge-fade mask (DriveCard.css/QueueTab.css) only shows up
// when there's really something to scroll to.
//
// Two mechanisms work together:
// - No-deps useEffect re-checks scrollWidth after every render, catching
//   content changes (longer status strings, new device paths) without needing
//   to know which props affect each row's width. useEffect (not useLayoutEffect)
//   so the reads are async and don't block paint.
// - ResizeObserver + window-resize listener catch layout changes that don't
//   come from a re-render (window resize, column reflow, phone rotation).
//   ResizeObserver fires on element-level size changes; the window listener is
//   a fallback for environments where ResizeObserver doesn't fire on resize
//   (also required for the window-resize test in jsdom which stubs ResizeObserver).
export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el) setOverflowing(el.scrollWidth > el.clientWidth + 1)
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    window.addEventListener("resize", check)
    window.addEventListener("orientationchange", check)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", check)
      window.removeEventListener("orientationchange", check)
    }
  }, [])

  return { ref, fade: overflowing }
}
