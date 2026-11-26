// Plain http to anything but this machine sends the password across the
// network unencrypted (server.https: false). Judged from the page's own
// address rather than the backend config: behind a reverse proxy that handles
// HTTPS the page is https even though the backend serves http, and that's safe.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
export function isPlaintextSignIn(loc: Pick<Location, "protocol" | "hostname"> = window.location): boolean {
  return loc.protocol === "http:" && !LOOPBACK.has(loc.hostname)
}
