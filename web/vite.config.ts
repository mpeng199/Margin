import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.join(root, 'src/core'),
      '@modules': path.join(root, 'modules'),
      '@web': path.join(root, 'web/src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [root] },
    proxy: { '/api': { target: 'http://127.0.0.1:7317', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
