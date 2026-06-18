import { useEffect, useLayoutEffect, useRef, useState } from "react"

// Tracks whether an element's content actually overflows its own box, so a
// scrollable row's edge-fade mask (DriveCard.css/QueueTab.css) only shows up
// when there's really something to scroll to — a plain CSS mask can't tell
// the difference and ends up fading a row that already fits just as much as
// one that doesn't.
//
// The no-deps useLayoutEffect re-checks after every render (cheap — just two
// property reads), which is what picks up content changes (a longer status
// message, a drive's device path changing) without this hook needing to know
// which props actually affect any particular row's width. The resize/
// orientationchange listeners separately catch layout changes that don't
// come from a re-render at all (window resize, phone rotation).
export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflowing(el.scrollWidth > el.clientWidth + 1)
  })

  useEffect(() => {
    const recheck = () => {
      const el = ref.current
      if (el) setOverflowing(el.scrollWidth > el.clientWidth + 1)
    }
    window.addEventListener("resize", recheck)
    window.addEventListener("orientationchange", recheck)
    return () => {
      window.removeEventListener("resize", recheck)
      window.removeEventListener("orientationchange", recheck)
    }
  }, [])

  return { ref, fade: overflowing }
}
