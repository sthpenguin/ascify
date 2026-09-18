import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves the app from a project sub-path, so every asset URL has
// to resolve under /ascify/ rather than the origin root.
const BASE = '/ascify/';

export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss()],
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
