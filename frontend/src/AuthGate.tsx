import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { AuthContext } from "./authContext"
import type { AuthStatus } from "./authContext"
import LoginScreen from "./LoginScreen"
import "./LoginScreen.css"

// How often to re-check while there's nothing to log in to yet (backend down,
// or no password set), so the page moves on by itself once that's fixed.
const RECHECK_MS = 3_000

// Shows the app only to a signed-in user. Everything else under /api answers
// 401 without a session (backend/system_utils/auth.py), so the app is never
// mounted just to fail; a 401 later on (session expired, password changed)
// comes back through expire() and lands here again.
export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const check = useCallback(() =>
    fetch("/api/auth/status")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<AuthStatus>
      })
      .then(s => { setStatus(s); setUnreachable(false) })
      .catch(() => setUnreachable(true)),
  [])

  useEffect(() => { check() }, [check])

  const waiting = unreachable || status?.configured === false
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(check, RECHECK_MS)
    return () => clearInterval(id)
  }, [waiting, check])

  const expire = useCallback(() => {
    setStatus(s => s && { ...s, authenticated: false, username: null })
  }, [])

  const signOut = useCallback(() => {
    fetch("/api/auth/logout", { method: "POST" }).finally(expire)
  }, [expire])

  const value = useMemo(
    () => ({ username: status?.username ?? null, signOut, expire }),
    [status?.username, signOut, expire],
  )

  if (status === null) {
    return unreachable
      ? <div className="login-screen"><p className="login-note">Backend unavailable — retrying…</p></div>
      : null
  }

  if (!status.configured) {
    return (
      <div className="login-screen">
        <div className="login-card login-card-wide">
          <h1 className="login-title">drivecheck</h1>
          <p className="login-note">No password is set yet. On the server, from the repository root, run:</p>
          <pre className="login-cmd">backend/.venv/bin/python scripts/set_password.py</pre>
          <p className="login-note">This page continues once it's done.</p>
        </div>
      </div>
    )
  }

  if (!status.authenticated) {
    return <LoginScreen onSignedIn={username => setStatus({ configured: true, authenticated: true, username })} />
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
