import { act, useCallback } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEdgeFade } from './useEdgeFade'

function setSize(node: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(node, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(node, 'clientWidth', { value: clientWidth, configurable: true })
}

function Box({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  const { ref, fade } = useEdgeFade<HTMLDivElement>()
  // Memoized so React only invokes it on actual mount/unmount — an inline
  // closure gets a new identity every render, which would make React
  // re-invoke it (and re-apply the original static size) on every re-render
  // the hook's own no-deps layout effect causes, fighting our manual
  // post-mount DOM mutations below.
  const setRef = useCallback((node: HTMLDivElement | null) => {
    ref.current = node
    if (node) setSize(node, scrollWidth, clientWidth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div data-testid="box" data-fade={fade} ref={setRef} />
}

describe('useEdgeFade', () => {
  it('reports no overflow when content fits within the box', () => {
    render(<Box scrollWidth={100} clientWidth={100} />)
    expect(screen.getByTestId('box').dataset.fade).toBe('false')
  })

  it('reports overflow when content is wider than the box', () => {
    render(<Box scrollWidth={200} clientWidth={100} />)
    expect(screen.getByTestId('box').dataset.fade).toBe('true')
  })

  it('does not flag a 1px rounding difference as overflow', () => {
    render(<Box scrollWidth={101} clientWidth={100} />)
    expect(screen.getByTestId('box').dataset.fade).toBe('false')
  })

  it('rechecks on window resize', () => {
    render(<Box scrollWidth={100} clientWidth={100} />)
    const box = screen.getByTestId('box')
    expect(box.dataset.fade).toBe('false')

    setSize(box, 200, 100)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(box.dataset.fade).toBe('true')
  })
})
