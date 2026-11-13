import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ContextSubmenu from './ContextSubmenu'

function setup() {
  const onItem = vi.fn()
  const onMenuClick = vi.fn()
  render(
    <div className="dc-ctx-menu" onClick={onMenuClick}>
      <ContextSubmenu label="Copy">
        <button onClick={onItem}>Serial</button>
      </ContextSubmenu>
      <button>Rename drive</button>
    </div>,
  )
  const trigger = screen.getByRole('button', { name: 'Copy' })
  const wrap = trigger.parentElement!
  return { trigger, wrap, onItem, onMenuClick }
}

const panel = () => screen.queryByRole('menu')

describe('ContextSubmenu', () => {
  afterEach(() => { vi.useRealTimers() })

  it('opens on hover and shows its items', () => {
    const { wrap, trigger } = setup()
    expect(panel()).toBeNull()
    fireEvent.mouseEnter(wrap)
    expect(panel()).toHaveTextContent('Serial')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('stays open through a short trip outside, and closes after a longer one', () => {
    vi.useFakeTimers()
    const { wrap } = setup()
    fireEvent.mouseEnter(wrap)
    fireEvent.mouseLeave(wrap)
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.mouseEnter(wrap)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(panel()).not.toBeNull()

    fireEvent.mouseLeave(wrap)
    act(() => { vi.advanceTimersByTime(250) })
    expect(panel()).toBeNull()
  })

  it('opens on a tap, and a second tap (after the emulated hover) keeps it open', () => {
    const { wrap, trigger, onMenuClick } = setup()
    fireEvent.mouseEnter(wrap)
    fireEvent.click(trigger)
    expect(panel()).not.toBeNull()
    fireEvent.click(trigger)
    expect(panel()).not.toBeNull()
    expect(onMenuClick).not.toHaveBeenCalled()
  })

  it("passes clicks on its items through to the item's handler", () => {
    const { trigger, onItem } = setup()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Serial' }))
    expect(onItem).toHaveBeenCalled()
  })

  it('opens to the left when there is no room on the right', () => {
    const { trigger } = setup()
    const menu = document.querySelector('.dc-ctx-menu')!
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ right: window.innerWidth - 50 } as DOMRect)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 150, height: 100, top: 10 } as DOMRect)
    fireEvent.click(trigger)
    expect(panel()).toHaveClass('ctx-sub-left')
    rect.mockRestore()
  })
})
