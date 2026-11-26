import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SummaryTab, { AllDrivesTab } from './SummaryTab'
import { makeDrive } from './test/fixtures'

const drives = [
  makeDrive({ guid: 'a', model: 'Alpha', serial: 'SA' }),
  makeDrive({ guid: 'b', model: 'Bravo', serial: 'SB' }),
  makeDrive({ guid: 'c', model: 'Charlie', serial: 'SC' }),
]

describe('SummaryTab', () => {
  it('asks for a selection when none is made', () => {
    render(<SummaryTab drives={drives} selectedGuids={[]} />)
    expect(screen.getByText('Select one or more drives to see a summary.')).toBeInTheDocument()
  })

  it('stacks a block per selected drive, in selection order', () => {
    const { container } = render(<SummaryTab drives={drives} selectedGuids={['c', 'a']} />)
    const blocks = container.querySelectorAll('.sum-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toHaveTextContent('Charlie')
    expect(blocks[1]).toHaveTextContent('Alpha')
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeInTheDocument()
  })
})

describe('AllDrivesTab', () => {
  it('lists every drive whatever is selected, marking the selected ones', () => {
    render(<AllDrivesTab drives={drives} selectedGuids={['b']} />)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByRole('button', { name: 'Copy Markdown' })).toBeInTheDocument()
  })
})
