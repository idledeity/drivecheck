import { useState } from "react"
import type { FormEvent } from "react"
import { IconLogin2 } from "@tabler/icons-react"

export default function LoginScreen({ onSignedIn }: { onSignedIn: (username: string) => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error ?? `Sign-in failed (HTTP ${r.status})`)
        onSignedIn(body.username)
      })
      .catch((err: unknown) => {
        setError(err instanceof TypeError ? "Backend unavailable" : (err as Error).message)
        setPassword("")
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">drivecheck</h1>
        <label className="login-field">
          <span>Username</span>
          <input autoFocus autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} />
        </label>
        <label className="login-field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" className="tinted-btn tint-cy login-submit" disabled={busy || !username || !password}>
          <IconLogin2 size={14} />
          Sign in
        </button>
      </form>
    </div>
  )
}
