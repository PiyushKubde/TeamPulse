import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const api = process.env.API_PROXY ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: { port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy: { '/api': api, '/health': api } },
  preview: { port: 4173, proxy: { '/api': api } },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], css: false },
})
