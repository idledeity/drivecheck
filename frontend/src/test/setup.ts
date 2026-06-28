import '@testing-library/jest-dom/vitest'

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

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
})

// jsdom doesn't implement scrollIntoView at all (it does no layout).
Element.prototype.scrollIntoView = () => {}
