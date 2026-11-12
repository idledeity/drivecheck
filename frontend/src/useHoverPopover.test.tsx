import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoverPopover } from './useHoverPopover'

const DELAY = 300
const CLOSE = 300 // the hook's default closeDelayMs

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

    it('ignores jitter below the threshold but restarts the delay on a real move', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY - 100)
      fireEvent.mouseMove(a, { clientX: 12, clientY: 11 })
      wait(100)
      expect(openKey()).toBe('a')
    })

    it('restarts the delay when the pointer moves before it opens', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY - 100)
      fireEvent.mouseMove(a, { clientX: 40, clientY: 10 })
      wait(100)
      expect(openKey()).toBeNull()
      wait(DELAY - 100)
      expect(openKey()).toBe('a')
    })

    it('stays open while the pointer moves about its trigger', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseMove(a, { clientX: 40, clientY: 30 })
      wait(DELAY + CLOSE)
      expect(openKey()).toBe('a')
    })

    it('closes shortly after the pointer leaves, and a pending open never fires', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseLeave(a)
      wait(CLOSE - 1)
      expect(openKey()).toBe('a')
      wait(1)
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

    it('stays open while the pointer is in the popover, and closes shortly after it leaves', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseLeave(a)
      fireEvent.mouseEnter(screen.getByTestId('pop'))
      wait(CLOSE * 3)
      expect(openKey()).toBe('a')

      fireEvent.mouseLeave(screen.getByTestId('pop'))
      wait(CLOSE)
      expect(openKey()).toBeNull()
    })

    it('keeps it open when the pointer comes back to the trigger in time', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      fireEvent.mouseEnter(a, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseLeave(a)
      wait(CLOSE - 100)
      fireEvent.mouseEnter(a, { clientX: 12, clientY: 10 })
      wait(CLOSE * 3)
      expect(openKey()).toBe('a')
    })

    it('lets the pointer cross another trigger on its way into the popover', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      const b = screen.getByTestId('b')
      fireEvent.mouseEnter(b, { clientX: 10, clientY: 10 })
      fireEvent.mouseMove(b, { clientX: 10, clientY: 10 })
      wait(DELAY)
      expect(openKey()).toBe('b')

      // Out of the pill, across the bar around it, into the popover.
      fireEvent.mouseLeave(b)
      fireEvent.mouseMove(a, { clientX: 10, clientY: 18 })
      expect(openKey()).toBe('b')
      fireEvent.mouseEnter(screen.getByTestId('pop'))
      wait(DELAY + CLOSE)
      expect(openKey()).toBe('b')
    })

    it('switches to another trigger the pointer rests on', () => {
      render(<Surface />)
      const a = screen.getByTestId('a')
      const b = screen.getByTestId('b')
      fireEvent.mouseEnter(b, { clientX: 10, clientY: 10 })
      fireEvent.mouseMove(b, { clientX: 10, clientY: 10 })
      wait(DELAY)
      fireEvent.mouseLeave(b)
      wait(100)
      fireEvent.mouseMove(a, { clientX: 40, clientY: 10 })
      expect(openKey()).toBe('b')
      wait(CLOSE - 100)
      expect(openKey()).toBeNull()
      wait(100)
      expect(openKey()).toBe('a')
    })

    it('flips above the pointer when it would run off the bottom', () => {
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ width: 200, height: 150 } as DOMRect)
      render(<Surface />)
      const y = window.innerHeight - 50
      fireEvent.mouseEnter(screen.getByTestId('a'), { clientX: 10, clientY: y })
      wait(DELAY)
      expect(screen.getByTestId('pop').style.top).toBe(`${y - 12 - 150}px`)
      rect.mockRestore()
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

    it('stays open when the popover scrolls its own content', () => {
      render(<Surface supportsHover={false} />)
      fireEvent.click(screen.getByTestId('a'))
      fireEvent.scroll(screen.getByTestId('pop'))
      expect(openKey()).toBe('a')
    })

    it("keeps the popover's right-click and press from reaching the surface", () => {
      const onContextMenu = vi.fn()
      const onPointerDown = vi.fn()
      render(<div onContextMenu={onContextMenu} onPointerDown={onPointerDown}><Surface supportsHover={false} /></div>)
      fireEvent.click(screen.getByTestId('a'))
      fireEvent.contextMenu(screen.getByTestId('inside'))
      fireEvent.pointerDown(screen.getByTestId('inside'))
      expect(onContextMenu).not.toHaveBeenCalled()
      expect(onPointerDown).not.toHaveBeenCalled()
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
