import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InfoTab from './InfoTab'
import { fetchJsonResponse, makeDrive } from './test/fixtures'

const info = (serial: string) => ({ groups: [{ id: 'identity', title: 'Identity', as_of: null,
  rows: [{ key: 'serial', label: 'Serial number', value: serial, format: 'text' }] }] })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchJsonResponse({ a: info('SA'), b: info('SB') })))
})
afterEach(() => vi.unstubAllGlobals())

const drives = [makeDrive({ guid: 'a' }), makeDrive({ guid: 'b' })]

describe('InfoTab', () => {
  it('stacks each drive by default, with a Compare sub-tab for a table', async () => {
    const { container } = render(<InfoTab drives={drives} selectedGuids={['a', 'b']} />)
    await screen.findByText('SA')
    expect(container.querySelectorAll('.info-drive')).toHaveLength(2)
    expect(container.querySelector('.info-table')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(container.querySelector('.info-table')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'By drive' })).not.toHaveClass('active')
  })
})
