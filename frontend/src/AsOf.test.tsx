import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AsOf from './AsOf'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('AsOf', () => {
  it('shows the age, the exact time on hover, and the machine-readable time', () => {
    render(<AsOf at="2026-11-14T11:48:00Z" prefix="read" />)
    const time = screen.getByText('read 12m ago')
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('dateTime', '2026-11-14T11:48:00Z')
    expect(time.getAttribute('title')).not.toMatch(/Overdue/)
    expect(time).not.toHaveClass('asof-stale')
  })

  it('keeps counting while left open', () => {
    render(<AsOf at="2026-11-14T11:48:00Z" />)
    act(() => { vi.advanceTimersByTime(5 * 60_000) })
    expect(screen.getByText('17m ago')).toBeInTheDocument()
  })

  it('turns overdue past staleAfterS, and says so on hover', () => {
    render(<AsOf at="2026-11-14T11:58:00Z" staleAfterS={60} />)
    const time = screen.getByText('2m ago')
    expect(time).toHaveClass('asof-stale')
    expect(time.getAttribute('title')).toMatch(/^Overdue: last read /)
  })
})
