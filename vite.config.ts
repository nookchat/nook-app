import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base, so the built site works from any sub path on any static host.
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
