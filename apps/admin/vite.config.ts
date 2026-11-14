import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built files go into the Worker's static assets, under /admin/.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: '../api/public/admin', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
