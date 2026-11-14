import { defineConfig } from 'vite';

// The landing page is served at the site root, but its built files live under /landing/.
export default defineConfig({
  base: '/landing/',
  build: { outDir: '../api/public/landing', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
