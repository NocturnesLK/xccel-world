import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: '/xccel-world/',
  publicDir: 'Resources',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
