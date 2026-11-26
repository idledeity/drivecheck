// The backend serves one scheme, server.https (backend/system_utils/tls.py),
// on one host and port. A restart that changes it leaves this page's own
// address answering nothing, so the restart flow moves the page across. The
// Vite dev server follows the backend's scheme by itself (vite.config.ts), so
// the same holds for a page it serves.

export type SchemeMove = {
  /** The scheme the backend serves after the restart. */
  https: boolean
  /** This page's address on that scheme. */
  url: string
}

/** This page's address on the other scheme, or null when it's already on the one
 *  the backend will serve. */
export function schemeSwitchTarget(https: boolean, loc: Pick<Location, "protocol" | "host" | "pathname" | "search" | "hash"> = window.location): string | null {
  if ((loc.protocol === "https:") === https) return null
  return `${https ? "https:" : "http:"}//${loc.host}${loc.pathname}${loc.search}${loc.hash}`
}

/** Where the page has to go after the restart, read from the saved server.https
 *  before restarting; null when it stays put or the setting can't be read. */
export async function pendingSchemeMove(): Promise<SchemeMove | null> {
  try {
    const res = await fetch("/api/config")
    if (!res.ok) return null
    const props = await res.json() as { key: string; value: unknown }[]
    const https = props.find(p => p.key === "server.https")?.value
    if (typeof https !== "boolean") return null
    const url = schemeSwitchTarget(https)
    return url ? { https, url } : null
  } catch {
    return null
  }
}

/** Whether something serves url within timeoutMs, checking once a second. Only
 *  for an https url from an http page: an https page may not fetch http
 *  (mixed content), and an https url fails here until the browser trusts its
 *  certificate. no-cors because it's another origin; the opaque answer is
 *  enough to know the server is up. */
export async function answersWithin(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(new URL("/", url).href, { mode: "no-cors", cache: "no-store" })
      return true
    } catch {
      // Not up yet, or the certificate isn't trusted.
    }
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, 1000))
  }
}

/** Sends the browser to url. A separate function so tests can replace it. */
export function goTo(url: string) {
  window.location.replace(url)
}
