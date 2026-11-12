import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoverPopover } from './useHoverPopover'

const DELAY = 300

// An outer trigger ("a") with a nested trigger ("b") inside it, plus a
// neutral element elsewhere on the page.
function Surface({ supportsHover = true }: { supportsHover?: boolean }) {
  const pop = useHoverPopover<'a' | 'b'>({ supportsHover, delayMs: DELAY })
  return (
    <div>
      <div data-testid="a" {...pop.trigger('a')}>
        <button data-testid="b" {...pop.trigger('b')} />
      </div>
      <div data-testid="elsewhere" />
      {pop.open && (
        <div data-testid="pop" data-key={pop.open} style={pop.pos} {...pop.popoverProps}>
          <button data-testid="inside" />
          <button data-testid="close" onClick={pop.close} />
        </div>
      )}
    </div>
  )
}

const openKey = () => screen.queryByTestId('pop')?.dataset.key ?? null
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('useHoverPopover', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  describe('with a mouse', () => {
    it('opens only after the pointer rests for the delay', () => {
      render(<Surface />)
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: 10, clientY: 10 })
      wait(DELAY - 1)
      expect(openKey()).toBeNull()
      wait(1)
      expect(openKey()).toBe('a')
    })

    it('positions the popover just below the pointer', () => {
      render(<Surface />)
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: 50, clientY: 60 })
      wait(DELAY)
      const style = screen.getByTestId('pop').style
      expect(style.left).toBe('50px')
      expect(style.top).toBe('72px')
    })

    it('keeps the popover inside the viewport near the right and bottom edges', () => {
      render(<Surface />)
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: window.innerWidth - 5, clientY: window.innerHeight - 5 })
      wait(DELAY)
      const style = screen.getByTestId('pop').style
      expect(parseFloat(style.left)).toBeLessThanOrEqual(window.innerWidth - 280 - 8)
      expect(parseFloat(style.top)).toBeLessThanOrEqual(window.innerHeight - 160 - 8)
    })

    it('ignores jitter below the threshold but hides and re-arms on a real move', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseMove(a, { clientX: 12, clientY: 11 })
      expect(openKey()).toBe('a')

      fireEvent.mouseMove(a, { clientX: 40, clientY: 10 })
      expect(openKey()).toBeNull()
      wait(DELAY)
      expect(openKey()).toBe('a')
    })

    it('closes when the pointer leaves, and a pending open never fires', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseLeave(a)
      expect(openKey()).toBeNull()

      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      fireEvent.mouseLeave(a)
      wait(DELAY * 2)
      expect(openKey()).toBeNull()
    })

    it('opens the innermost trigger under the pointer', () => {
      render(<Surface />)
      const b = screen.getByTestId('b')
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: 10, clientY: 10 })
      fireEvent.mouseEnter(b, { clientX: 11, clientY: 10 })
      fireEvent.mouseMove(b, { clientX: 11, clientY: 10 })
      wait(DELAY)
      expect(openKey()).toBe('b')
    })

    it('does not open on click', () => {
      render(<Surface />)
      fireEvent.click(screen.getByTestId('a'), { clientX: 10, clientY: 10 })
      expect(openKey()).toBeNull()
    })
  })

  describe('with touch', () => {
    it('ignores hover', () => {
      render(<Surface supportsHover={false} />)
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: 10, clientY: 10 })
      wait(DELAY)
      expect(openKey()).toBeNull()
    })

    it('toggles on tap, and a tap on another trigger switches to it', () => {
      render(<Surface supportsHover={false} />)
      const a = screen.getByTestId('a')
      fireEvent.click(a)
      expect(openKey()).toBe('a')
      fireEvent.click(screen.getByTestId('b'))
      expect(openKey()).toBe('b')
      fireEvent.click(screen.getByTestId('b'))
      expect(openKey()).toBeNull()
    })

    it('stops the tap from reaching the surface underneath', () => {
      const onSurfaceClick = vi.fn()
      render(<div onClick={onSurfaceClick}><Surface supportsHover={false} /></div>)
      fireEvent.click(screen.getByTestId('a'))
      expect(onSurfaceClick).not.toHaveBeenCalled()
    })

    it('stays open while hover events arrive (emulated mouse events after a tap)', () => {
      render(<Surface supportsHover={false} />)
      const a = screen.getByTestId('a')
      fireEvent.click(a)
      fireEvent.mouseLeave(a)
      expect(openKey()).toBe('a')
    })
  })

  describe('closing', () => {
    it('stays open on a click inside the popover', () => {
      render(<Surface supportsHover={false} />)
      fireEvent.click(screen.getByTestId('a'))
      fireEvent.click(screen.getByTestId('inside'))
      expect(openKey()).toBe('a')
    })

    it('closes on a click elsewhere', () => {
      render(<Surface supportsHover={false} />)
      fireEvent.click(screen.getByTestId('a'))
      fireEvent.click(screen.getByTestId('elsewhere'))
      expect(openKey()).toBeNull()
    })

    it('closes on scroll', () => {
      render(<Surface supportsHover={false} />)
      fireEvent.click(screen.getByTestId('a'))
      fireEvent.scroll(window)
      expect(openKey()).toBeNull()
    })

    it('closes through close(), and the next tap opens it again', () => {
      render(<Surface supportsHover={false} />)
      fireEvent.click(screen.getByTestId('a'))
      fireEvent.click(screen.getByTestId('close'))
      expect(openKey()).toBeNull()
      fireEvent.click(screen.getByTestId('a'))
      expect(openKey()).toBe('a')
    })

    it('cancels a pending open on unmount', () => {
      const { unmount } = render(<Surface />)
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: 10, clientY: 10 })
      expect(vi.getTimerCount()).toBe(1)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
