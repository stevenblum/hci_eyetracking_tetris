import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs keep the static build usable from GitHub Pages project
  // paths without needing a server rewrite or repository-name-specific base.
  base: './',
  server: {
    host: 'localhost',
    port: 5173,
  },
  preview: {
    host: 'localhost',
    port: 4173,
  },
});
