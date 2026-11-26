import { describe, expect, it } from 'vitest'
import { schemeSwitchTarget } from './schemeSwitch'

const at = (href: string) => new URL(href)

describe('schemeSwitchTarget', () => {
  it('keeps host, port, path, query and hash on the new scheme', () => {
    expect(schemeSwitchTarget(true, at('http://nas.lan:4343/drives?x=1#top'))).toBe('https://nas.lan:4343/drives?x=1#top')
    expect(schemeSwitchTarget(false, at('https://10.0.0.5:4343/'))).toBe('http://10.0.0.5:4343/')
  })

  it('is null when the page is already on that scheme', () => {
    expect(schemeSwitchTarget(true, at('https://nas.lan:4343/'))).toBeNull()
    expect(schemeSwitchTarget(false, at('http://nas.lan:4343/'))).toBeNull()
  })
})
