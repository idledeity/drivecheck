import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: false,
    // Proxy API calls to Flask during development
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})
