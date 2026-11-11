import { createContext, useContext } from "react"

export type AuthStatus = {
  configured: boolean
  authenticated: boolean
  username: string | null
}

export type AuthContextValue = {
  username: string | null
  /** End the session on the server, then show the login screen. */
  signOut: () => void
  /** The server answered 401: the session is gone, show the login screen. */
  expire: () => void
}

// The no-op default keeps components usable outside AuthGate (tests, previews).
export const AuthContext = createContext<AuthContextValue>({
  username: null,
  signOut: () => {},
  expire: () => {},
})

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
