import { describe, expect, it } from 'vitest'
import { isPlaintextSignIn } from './plaintextSignIn'

describe('isPlaintextSignIn', () => {
  it('warns for http to another host', () => {
    expect(isPlaintextSignIn({ protocol: 'http:', hostname: '192.168.1.239' })).toBe(true)
  })
  it('does not warn for https', () => {
    expect(isPlaintextSignIn({ protocol: 'https:', hostname: '192.168.1.239' })).toBe(false)
  })
  it('does not warn for http to this machine', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isPlaintextSignIn({ protocol: 'http:', hostname })).toBe(false)
    }
  })
})
