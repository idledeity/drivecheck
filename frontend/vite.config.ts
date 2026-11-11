import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

type BackendTls = { https: false } | { https: true; cert: string; key: string }

// Serve the dev server the way the backend serves: over HTTPS with the same
// certificate when server.https is on (backend/system_utils/tls.py, which also
// creates the self-signed certificate if this starts before the backend does).
function backendTls(): BackendTls {
  const backend = fileURLToPath(new URL('../backend', import.meta.url))
  const out = execFileSync('.venv/bin/python', ['-m', 'system_utils.tls'], {
    cwd: backend,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return JSON.parse(out) as BackendTls
}

export default defineConfig(({ command }) => {
  // Tests and builds don't serve anything, so they don't need a certificate.
  const tls = command === 'serve' && !process.env.VITEST ? backendTls() : { https: false as const }
  const scheme = tls.https ? 'https' : 'http'

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      open: false,
      https: tls.https ? { cert: readFileSync(tls.cert), key: readFileSync(tls.key) } : undefined,
      // Proxy API calls to Flask during development
      proxy: {
        // changeOrigin off: forward the browser's own Host header, so the
        // backend's cross-origin write check (system_utils/origin_guard.py) sees
        // Origin and Host agree, as they do for the page that made the request.
        // secure off: the backend's certificate may be self-signed; this hop
        // never leaves the machine.
        '/api': { target: `${scheme}://localhost:4343`, changeOrigin: false, secure: false },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
