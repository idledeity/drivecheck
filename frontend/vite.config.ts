import { execFileSync } from 'node:child_process'
import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

type BackendTls = ({ https: false } | { https: true; cert: string; key: string }) & { serving?: string }

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

// Restarts the dev server when the backend starts serving the other scheme.
// The backend rewrites `serving` (a JSON {"https": bool}) each time it starts
// (tls.write_serving); a restart re-runs this config, which picks up the new
// scheme for both this server and the /api proxy. Following the backend's
// actual start, not config.yaml, keeps the two in step: a saved
// server.https only applies once the backend restarts.
function followBackendScheme(tls: BackendTls): Plugin {
  return {
    name: 'drivecheck-follow-backend-scheme',
    configureServer(server) {
      const serving = tls.serving
      if (!serving) return
      // watchFile polls stat, so it sees the file replaced (os.replace) as well as
      // edited. Only this server's own listener is ever removed: a restart
      // builds the new server before it closes the old one.
      const onChange = () => {
        let https: unknown
        try {
          https = (JSON.parse(readFileSync(serving, 'utf8')) as { https?: unknown }).https
        } catch {
          return  // missing or half-written; the next change brings it back
        }
        if (typeof https !== 'boolean' || https === tls.https) return
        server.config.logger.info(`backend now serves ${https ? 'HTTPS' : 'HTTP'}; restarting the dev server`, { timestamp: true })
        unwatchFile(serving, onChange)
        void server.restart()
      }
      watchFile(serving, { interval: 500 }, onChange)
      server.httpServer?.on('close', () => unwatchFile(serving, onChange))
    },
  }
}

export default defineConfig(({ command }) => {
  // Tests and builds don't serve anything, so they don't need a certificate.
  const tls = command === 'serve' && !process.env.VITEST ? backendTls() : { https: false as const }
  const scheme = tls.https ? 'https' : 'http'

  return {
    plugins: [react(), followBackendScheme(tls)],
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
      // Share one jsdom per worker instead of building one per file — that setup
      // was ~half the run. `npm run test:isolated` runs with isolation back on.
      isolate: false,
    },
  }
})
