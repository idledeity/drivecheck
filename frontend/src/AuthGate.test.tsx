import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuthGate from './AuthGate'
import { useAuth } from './authContext'
import { fetchJsonResponse } from './test/fixtures'

function Protected() {
  const auth = useAuth()
  return (
    <div>
      <p>Protected for {auth.username}</p>
      <button onClick={auth.signOut}>Sign out</button>
      <button onClick={auth.expire}>Expire</button>
    </div>
  )
}

type Status = { configured: boolean; authenticated: boolean; username: string | null }

function mockBackend(initial: Status, login: (body: { username: string; password: string }) => Response) {
  const state = { status: initial }
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input)
    if (url === '/api/auth/status') return Promise.resolve(fetchJsonResponse(state.status))
    if (url === '/api/auth/login') return Promise.resolve(login(JSON.parse(String(init?.body))))
    if (url === '/api/auth/logout') return Promise.resolve(fetchJsonResponse({ authenticated: false }))
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  return state
}

const OK_LOGIN = () => fetchJsonResponse({ authenticated: true, username: 'admin' })

function renderGate() {
  render(<AuthGate><Protected /></AuthGate>)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthGate', () => {
  it('shows the app straight away for a signed-in session', async () => {
    mockBackend({ configured: true, authenticated: true, username: 'admin' }, OK_LOGIN)
    renderGate()
    expect(await screen.findByText('Protected for admin')).toBeInTheDocument()
  })

  it('explains how to set a password when none is set', async () => {
    mockBackend({ configured: false, authenticated: false, username: null }, OK_LOGIN)
    renderGate()
    expect(await screen.findByText(/No password is set yet/)).toBeInTheDocument()
    expect(screen.getByText('backend/.venv/bin/python scripts/set_password.py')).toBeInTheDocument()
    expect(screen.queryByText(/Protected/)).not.toBeInTheDocument()
  })

  it('signs in through the login form', async () => {
    const login = vi.fn(OK_LOGIN)
    mockBackend({ configured: true, authenticated: false, username: null }, login)
    renderGate()

    const submit = await screen.findByRole('button', { name: 'Sign in' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse')
    await userEvent.click(submit)

    expect(login).toHaveBeenCalledWith({ username: 'admin', password: 'correct horse' })
    expect(await screen.findByText('Protected for admin')).toBeInTheDocument()
  })

  it("shows the server's error and clears the password on a failed sign-in", async () => {
    mockBackend({ configured: true, authenticated: false, username: null },
      () => fetchJsonResponse({ error: 'wrong username or password' }, 401))
    renderGate()

    await userEvent.type(await screen.findByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'nope nope')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('wrong username or password')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.queryByText(/Protected/)).not.toBeInTheDocument()
  })

  it('returns to the login form when the session expires', async () => {
    mockBackend({ configured: true, authenticated: true, username: 'admin' }, OK_LOGIN)
    renderGate()
    await userEvent.click(await screen.findByRole('button', { name: 'Expire' }))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText(/Protected/)).not.toBeInTheDocument()
  })

  it('signs out on the server and returns to the login form', async () => {
    mockBackend({ configured: true, authenticated: true, username: 'admin' }, OK_LOGIN)
    renderGate()
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' }))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
