import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ConfirmProvider from './ConfirmProvider'
import { useConfirm, type Confirm } from './confirmContext'

// Hands the test the provider's confirm() so it can ask directly.
function setup() {
  let confirm: Confirm = () => Promise.resolve(false)
  function Grab() { confirm = useConfirm(); return null }
  render(<ConfirmProvider><Grab /></ConfirmProvider>)
  const ask = () => {
    let answer: Promise<boolean> = Promise.resolve(false)
    act(() => { answer = confirm({ title: 'Do it?', detail: 'It cannot be undone.', confirmLabel: 'Do it', cancelLabel: 'Leave it' }) })
    return answer
  }
  return { ask }
}

describe('ConfirmProvider', () => {
  it('shows the question and resolves true on the confirm button', async () => {
    const { ask } = setup()
    const answer = ask()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Do it?')
    expect(dialog).toHaveTextContent('It cannot be undone.')
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }))
    await expect(answer).resolves.toBe(true)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it.each([
    ['the way-out button', () => fireEvent.click(screen.getByRole('button', { name: 'Leave it' }))],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a click on the backdrop', () => fireEvent.click(document.querySelector('.confirm-scrim')!)],
  ])('resolves false on %s', async (_, dismiss) => {
    const { ask } = setup()
    const answer = ask()
    dismiss()
    await expect(answer).resolves.toBe(false)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('focuses the way out, so a stray Enter does not confirm', () => {
    const { ask } = setup()
    void ask()
    expect(screen.getByRole('button', { name: 'Leave it' })).toHaveFocus()
  })

  it('answers false to an unanswered question when a new one replaces it', async () => {
    const { ask } = setup()
    const first = ask()
    const second = ask()
    await expect(first).resolves.toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }))
    await expect(second).resolves.toBe(true)
  })
})
