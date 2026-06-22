import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DetailRow, JobDetailRows } from './JobDetails'
import { makeJob } from './test/fixtures'

describe('DetailRow', () => {
  it('renders the label and value', () => {
    render(<DetailRow label="Category" value="Test" />)
    expect(screen.getByText('Category')).toBeInTheDocument()
    expect(screen.getByText('Test')).toBeInTheDocument()
  })
})

describe('JobDetailRows', () => {
  it('always renders category and created timestamp', () => {
    render(<JobDetailRows job={makeJob({ category: 'Scan' })} />)
    expect(screen.getByText('Category')).toBeInTheDocument()
    expect(screen.getByText('Scan')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
  })

  it('omits started/finished rows when not set', () => {
    render(<JobDetailRows job={makeJob({ started_at: null, finished_at: null })} />)
    expect(screen.queryByText('Started')).not.toBeInTheDocument()
    expect(screen.queryByText('Finished')).not.toBeInTheDocument()
  })

  it('renders started/finished rows when set', () => {
    render(<JobDetailRows job={makeJob({ started_at: '2026-01-01T00:01:00Z', finished_at: '2026-01-01T00:02:00Z' })} />)
    expect(screen.getByText('Started')).toBeInTheDocument()
    expect(screen.getByText('Finished')).toBeInTheDocument()
  })

  it('renders one row per param with a humanized label', () => {
    render(<JobDetailRows job={makeJob({ params: { block_size: 4096 } })} />)
    expect(screen.getByText('Block size')).toBeInTheDocument()
    expect(screen.getByText('4096')).toBeInTheDocument()
  })

  it('renders one row per result entry with a humanized label', () => {
    render(<JobDetailRows job={makeJob({ result: { slept_seconds: 10 } })} />)
    expect(screen.getByText('Slept seconds')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('renders no result rows when result is null', () => {
    render(<JobDetailRows job={makeJob({ result: null })} />)
    expect(screen.queryByText('Slept seconds')).not.toBeInTheDocument()
  })
})
