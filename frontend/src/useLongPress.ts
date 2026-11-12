import { useEffect, useRef } from "react"

const LONG_PRESS_MS = 500

/**
 * Press-and-hold for touch screens, where there's no right-click: calls
 * `onLongPress` with the point first touched after LONG_PRESS_MS held down.
 *
 * The click that follows releasing a long press still fires; the surface's
 * click handler calls `consumeLongPress()` first and skips its normal action
 * when it returns true. `handlers` is empty when `enabled` is false.
 */
export function useLongPress(onLongPress: (pos: { x: number; y: number }) => void, enabled: boolean) {
  const timerRef = useRef<number | null>(null)
  const firedRef = useRef(false)

  const cancel = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    firedRef.current = false
    const pos = { x: e.clientX, y: e.clientY }
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true
      onLongPress(pos)
    }, LONG_PRESS_MS)
  }

  const consumeLongPress = () => {
    const fired = firedRef.current
    firedRef.current = false
    return fired
  }

  useEffect(() => () => cancel(), [])

  const handlers = enabled ? { onPointerDown, onPointerUp: cancel, onPointerCancel: cancel } : {}
  return { handlers, consumeLongPress }
}
