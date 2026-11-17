import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReadSmartButton from './ReadSmartButton'
import { SmartReadContext } from './smartReadContext'

function renderButton(reading: ReadonlySet<string>, ok = true) {
  const readSmart = vi.fn().mockResolvedValue(ok)
  const onDone = vi.fn()
  render(
    <SmartReadContext.Provider value={{ reading, readSmart }}>
      <ReadSmartButton guids={['guid-1']} onDone={onDone} />
    </SmartReadContext.Provider>,
  )
  return { readSmart, onDone }
}

describe('ReadSmartButton', () => {
  it('reads the drive, then calls onDone', async () => {
    const { readSmart, onDone } = renderButton(new Set())
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }))
    expect(readSmart).toHaveBeenCalledWith(['guid-1'])
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('leaves onDone out when the read failed', async () => {
    const { readSmart, onDone } = renderButton(new Set(), false)
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }))
    await waitFor(() => expect(readSmart).toHaveBeenCalled())
    await Promise.resolve()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('says Reading… and is disabled while the drive is being read', () => {
    renderButton(new Set(['guid-1']))
    expect(screen.getByRole('button', { name: 'Reading…' })).toBeDisabled()
  })
})
