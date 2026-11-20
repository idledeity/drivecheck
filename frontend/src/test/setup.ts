import '@testing-library/jest-dom/vitest'

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { popoverCounterViews, trendsCounterViews } from '../charts/counters'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

// React only wraps state updates correctly inside act() if it knows it's
// running under a test runner — Jest sets this automatically, Vitest doesn't.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// RTL's auto-cleanup relies on a global afterEach, which we don't enable
// (no `globals: true` in vite.config.ts) — so it's wired up explicitly here.
afterEach(() => {
  cleanup()
  sessionStorage.clear()
  // Counter cards remember their view across remounts; don't carry it between tests.
  trendsCounterViews.clear()
  popoverCounterViews.clear()
})

// jsdom doesn't implement scrollIntoView at all (it does no layout).
Element.prototype.scrollIntoView = () => {}

// jsdom doesn't implement ResizeObserver. Stub it out so components that use
// it (e.g. useEdgeFade) mount without errors. The callback is never invoked
// since jsdom does no layout anyway — tests that care about resize re-checks
// must trigger the callback manually via the mock if needed.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

// jsdom's getComputedStyle matches every element against its built-in default
// stylesheet, ~2ms a call, and Testing Library calls it for an element and each
// ancestor on every role query — over a third of the suite's time. Tests load no
// CSS, so all it can report is inline style plus those defaults; this keeps the
// defaults queries and jest-dom actually read (display, visibility) and drops the
// cascade.
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul'])
const NEVER_SHOWN = new Set(['head', 'script', 'style', 'template', 'title', 'meta', 'link', 'noscript'])
function defaultDisplay(el: Element): string {
  const tag = el.localName
  if (el.hasAttribute('hidden') || NEVER_SHOWN.has(tag)) return 'none'
  if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return 'none'
  if (tag === 'dialog' && !el.hasAttribute('open')) return 'none'
  const details = el.parentElement
  if (details?.localName === 'details' && !details.hasAttribute('open') && tag !== 'summary') return 'none'
  return BLOCK.has(tag) ? 'block' : 'inline'
}
const NO_STYLE = { getPropertyValue: () => '' }
window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
  if (pseudo) return NO_STYLE                         // no ::before/::after content without CSS
  const inline = (el as HTMLElement).style
  const value = (prop: string) => {
    const v = inline?.getPropertyValue(prop)
    if (v) return v
    if (prop === 'display') return defaultDisplay(el)
    if (prop === 'visibility') return 'visible'
    if (prop === 'pointer-events') return 'auto'
    if (prop === 'opacity') return '1'
    return ''
  }
  // Read as decl.display / decl.pointerEvents as well as getPropertyValue().
  return new Proxy({ getPropertyValue: value }, {
    get: (t, k) => k in t ? t[k as keyof typeof t]
      : typeof k === 'string' ? value(k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)) : undefined,
  })
}) as unknown as typeof window.getComputedStyle
