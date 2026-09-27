import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/, so assets use relative paths.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
});
