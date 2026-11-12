import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './useLongPress'

const consumed: boolean[] = []

function Surface({ onLongPress, enabled = true }: { onLongPress: (pos: { x: number; y: number }) => void; enabled?: boolean }) {
  const { handlers, consumeLongPress } = useLongPress(onLongPress, enabled)
  return <div data-testid="s" {...handlers} onClick={() => consumed.push(consumeLongPress())} />
}

describe('useLongPress', () => {
  beforeEach(() => { vi.useFakeTimers(); consumed.length = 0 })
  afterEach(() => { vi.useRealTimers() })

  it('fires at the first touch point after holding 500ms', () => {
    const onLongPress = vi.fn()
    render(<Surface onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId('s'), { clientX: 30, clientY: 40 })
    act(() => { vi.advanceTimersByTime(499) })
    expect(onLongPress).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onLongPress).toHaveBeenCalledWith({ x: 30, y: 40 })
  })

  it('does not fire when released early', () => {
    const onLongPress = vi.fn()
    render(<Surface onLongPress={onLongPress} />)
    const s = screen.getByTestId('s')
    fireEvent.pointerDown(s)
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.pointerUp(s)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('does not fire when the pointer is cancelled (e.g. the page scrolls)', () => {
    const onLongPress = vi.fn()
    render(<Surface onLongPress={onLongPress} />)
    const s = screen.getByTestId('s')
    fireEvent.pointerDown(s)
    fireEvent.pointerCancel(s)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('marks only the click right after a long press as consumed', () => {
    render(<Surface onLongPress={() => {}} />)
    const s = screen.getByTestId('s')
    fireEvent.pointerDown(s)
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.pointerUp(s)
    fireEvent.click(s)
    // A later plain tap is a normal click again.
    fireEvent.pointerDown(s)
    fireEvent.pointerUp(s)
    fireEvent.click(s)
    expect(consumed).toEqual([true, false])
  })

  it('attaches no handlers when disabled', () => {
    const onLongPress = vi.fn()
    render(<Surface onLongPress={onLongPress} enabled={false} />)
    fireEvent.pointerDown(screen.getByTestId('s'))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('does not fire after unmount', () => {
    const onLongPress = vi.fn()
    const { unmount } = render(<Surface onLongPress={onLongPress} />)
    fireEvent.pointerDown(screen.getByTestId('s'))
    unmount()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onLongPress).not.toHaveBeenCalled()
  })
})
