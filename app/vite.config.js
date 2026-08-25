import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // engine-core is a CommonJS workspace package linked via node_modules symlink;
  // without this Vite resolves the real path outside node_modules and serves it
  // as raw source instead of running it through CJS->ESM interop.
  resolve: { preserveSymlinks: true },
  optimizeDeps: { include: ['@tss-pricing/engine-core'] },
  server: {
    // Backend-orchestrated mode calls srv/ (CAP, default port 4004) — proxying avoids
    // needing CORS-friendly absolute URLs or VITE_API_BASE_URL for local dev.
    proxy: { '/rest': 'http://localhost:4004' },
  },
})
