import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = '/ascify/';

/**
 * GitHub Pages serves static files only, so a deep link like /ascify/about
 * 404s unless a fallback document exists. Copying index.html to 404.html is
 * the standard Pages SPA shim; the router reads location.pathname either way.
 */
function pagesSpaFallback() {
  return {
    name: 'ascify:pages-spa-fallback',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const index = resolve(process.cwd(), 'dist', 'index.html');
      // A failed build leaves no index.html; don't mask the real error with an
      // ENOENT from the copy.
      if (!existsSync(index)) return;
      copyFileSync(index, resolve(process.cwd(), 'dist', '404.html'));
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Scope + start_url are pinned to the Pages sub-path so the installed
      // app and the service worker both stay inside /ascify/.
      scope: BASE,
      base: BASE,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        id: BASE,
        name: 'ascify — client-side retro media effects',
        short_name: 'ascify',
        description:
          'Convert images, GIFs, video and GLB models into ASCII and other retro effects. 100% on-device.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'any',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        categories: ['graphics', 'photo', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
        ],
      },
      workbox: {
        // Only first-party build output is precached. User media is never
        // handed to the service worker, and there is no runtime caching rule
        // that could capture a blob: or data: response.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/node_modules/**'],
        navigateFallback: `${BASE}index.html`,
        navigateFallbackDenylist: [/^\/ascify\/(assets|icons)\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
    pagesSpaFallback(),
  ],
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    minify: 'terser',
    terserOptions: { compress: { drop_console: true, drop_debugger: true } },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('three')) return 'three';
          if (id.includes('react')) return 'react';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  worker: { format: 'es' },
});
