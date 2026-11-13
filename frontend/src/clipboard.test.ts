import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// jsdom has no execCommand; give the fallback one to call.
function stubExecCommand(result: boolean) {
  const exec = vi.fn().mockReturnValue(result)
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
  return exec
}

describe('copyText', () => {
  it('uses the Clipboard API on a secure page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText('ZAD1V2H0')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('ZAD1V2H0')
  })

  it('falls back to a hidden textarea over plain http, and removes it after', async () => {
    vi.stubGlobal('isSecureContext', false)
    let copied: string | null = null
    const exec = stubExecCommand(true)
    exec.mockImplementation(() => { copied = document.querySelector('textarea')?.value ?? null; return true })
    await expect(copyText('/dev/sdb')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    expect(copied).toBe('/dev/sdb')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back when the Clipboard API refuses', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('not focused')) } })
    stubExecCommand(true)
    await expect(copyText('x')).resolves.toBe(true)
  })

  it('reports failure when nothing works', async () => {
    vi.stubGlobal('isSecureContext', false)
    stubExecCommand(false)
    await expect(copyText('x')).resolves.toBe(false)
  })
})
