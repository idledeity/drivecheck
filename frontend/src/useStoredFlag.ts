import { useState } from "react"

/** An on/off preference remembered in this browser ("1" / "0" under `key`).
 *  Storage can be unavailable (a private window, blocked site data), so it
 *  only ever falls back to `fallback`. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? fallback : v === "1"
    } catch { return fallback }
  })
  return [on, next => {
    setOn(next)
    try { localStorage.setItem(key, next ? "1" : "0") } catch { /* not remembered */ }
  }]
}
