import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built files go into the Worker's static assets, under /app/.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: '../api/public/app', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
