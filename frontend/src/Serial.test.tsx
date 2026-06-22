import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Serial from './Serial'

describe('Serial', () => {
  it('renders the given value', () => {
    render(<Serial value="ABC123" />)
    expect(screen.getByText('ABC123')).toBeInTheDocument()
  })

  it('applies the base class plus an optional extra class', () => {
    render(<Serial value="ABC123" className="extra" />)
    expect(screen.getByText('ABC123').closest('span')).toHaveClass('serial-tag', 'extra')
  })

  it('omits the extra class when none is given', () => {
    render(<Serial value="ABC123" />)
    const span = screen.getByText('ABC123').closest('span')
    expect(span).toHaveClass('serial-tag')
    expect(span?.className).toBe('serial-tag')
  })
})
