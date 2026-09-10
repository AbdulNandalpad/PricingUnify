import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Workspace packages are linked via node_modules symlinks; resolving through the symlink
  // keeps them inside node_modules for Vite's dependency handling.
  resolve: { preserveSymlinks: true },
  server: {
    // The app calls srv/ (CAP, default port 4004) — proxying avoids CORS and VITE_API_BASE_URL
    // for local dev. Set VITE_API_MODE=mock to run without a backend (see src/mockApi.js).
    proxy: { '/rest': 'http://localhost:4004' },
  },
})
