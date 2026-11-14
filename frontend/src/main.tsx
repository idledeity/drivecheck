import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AuthGate from './AuthGate.tsx'

// Dev builds only: React 19.2 records every re-render with changed props as a
// performance.measure() entry (its DevTools "Performance Tracks"), with the
// changed props attached. The browser keeps those entries until they're
// cleared, and with the 2s poll that's ~45 a second — hundreds of MB over an
// afternoon, which made Firefox's cycle collector freeze the tab for 10+
// seconds at a time. A profiler recording keeps its own copy as they're
// created, so clearing the buffer doesn't hide them from a profile.
// Production builds don't create these entries at all.
if (import.meta.env.DEV) {
  setInterval(() => performance.clearMeasures(), 10_000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
