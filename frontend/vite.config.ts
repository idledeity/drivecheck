import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: false,
    // Proxy API calls to Flask during development
    proxy: {
      // changeOrigin off: forward the browser's own Host header, so the
      // backend's cross-origin write check (system_utils/origin_guard.py) sees
      // Origin and Host agree, as they do for the page that made the request.
      '/api': { target: 'http://localhost:4343', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
