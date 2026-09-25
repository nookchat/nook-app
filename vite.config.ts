import { defineConfig } from 'vite'

export default defineConfig({
  // Relative, so the build works from any sub path on a static host.
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
