import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const OUT = '../api/public/app';

// The on-device voice's speech runtime (ONNX Runtime WebAssembly), served from Niko itself instead of a CDN.
// These must be the build that kokoro-js 1.2.1 bundles (transformers 3.5.1), so their hashes are pinned.
const ORT_FILES: Record<string, string> = {
  'ort-wasm-simd-threaded.jsep.mjs': '08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9',
  'ort-wasm-simd-threaded.jsep.wasm': 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39',
};
function speechRuntime(): Plugin {
  return {
    name: 'niko-speech-runtime',
    apply: 'build',
    closeBundle() {
      const dist = dirname(require.resolve('@huggingface/transformers')); // .../dist/transformers.*.js
      mkdirSync(join(OUT, 'ort'), { recursive: true });
      for (const [name, sha] of Object.entries(ORT_FILES)) {
        const from = join(dist, name);
        const got = createHash('sha256').update(readFileSync(from)).digest('hex');
        if (got !== sha) throw new Error(`${name} does not match the pinned build (got ${got}). Keep @huggingface/transformers at 3.5.1.`);
        copyFileSync(from, join(OUT, 'ort', name));
      }
    },
  };
}

// Built files go into the Worker's static assets, under /app/.
export default defineConfig({
  base: '/app/',
  plugins: [react(), speechRuntime()],
  // kokoro-js's self-contained browser build (its package exports point at the Node build).
  resolve: { alias: { 'kokoro-web': require.resolve('kokoro-js').replace(/kokoro\.(c?js)$/, 'kokoro.web.js') } },
  worker: { format: 'es' },
  build: { outDir: OUT, emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
