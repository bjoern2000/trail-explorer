import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Multi-page build: index.html (map app) + matrix.html (source matrix) +
// benchmark.html (AllTrails vs open-data benchmark) + merge.html (segment merge) +
// data-model.html (the trail data model reference) +
// scope.html (Trail Scope product prototype) + weather-on-route.html (on-route
// conditions, promoted into the main nav as "Weather-on-route") + digest.html (the
// regional conditions digest, the same grades read in aggregate) + briefing.html (the
// region briefing, the one page whose content is a hand-typed sample rather than computed).
// Sections are listed in src/ui/nav.ts; adding a page means one input here + one
// PAGES entry there.
// Dev server proxies /api → the Express server (server.js) on :8081.
export default defineConfig({
  root: '.',
  // Mirrors the build input gate above so src/ui/nav.ts can drop the Super Res tab from a
  // build that does not contain the page. A nav link to a 404 is worse than no link.
  define: {
    __SUPERRES__: JSON.stringify(process.env.BUILD_SUPERRES === '1'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        matrix: resolve(__dirname, 'matrix.html'),
        benchmark: resolve(__dirname, 'benchmark.html'),
        merge: resolve(__dirname, 'merge.html'),
        'data-model': resolve(__dirname, 'data-model.html'),
        scope: resolve(__dirname, 'scope.html'),
        'weather-on-route': resolve(__dirname, 'weather-on-route.html'),
        digest: resolve(__dirname, 'digest.html'),
        briefing: resolve(__dirname, 'briefing.html'),
        // OPT-IN, and deliberately off by default. superres.html drives the SSDS
        // super-resolution API through server.js's proxy, and those /api/ssds/* routes
        // carry no auth, so a default-on build would put an unauthenticated proxy to a
        // TWC QA API on a public Railway URL running on a real key. Build it with
        // BUILD_SUPERRES=1 for local or once the routes are gated.
        //
        // `npm run dev` is unaffected: rollupOptions.input only governs `vite build`, and
        // the dev server serves any html on disk, so local work on the page continues.
        ...(process.env.BUILD_SUPERRES === '1'
          ? { superres: resolve(__dirname, 'superres.html') }
          : {}),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
    },
  },
});
