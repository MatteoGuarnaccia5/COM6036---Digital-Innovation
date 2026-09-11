import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The React client's build.
 *
 * In production Vite emits static files into `dist-client`, which the Express
 * app serves itself. That makes the API and the client the same origin, so the
 * session cookie is sent on every request with no CORS configuration and no
 * cross-site cookie relaxation - the simplest arrangement that is also the most
 * secure one.
 *
 * In development the Vite dev server owns the page and proxies `/api` to
 * Express, which preserves the same-origin illusion and keeps the cookie
 * working while hot reload is available.
 */
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist-client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
