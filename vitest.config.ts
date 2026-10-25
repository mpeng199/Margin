import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@int': path.resolve(__dirname, 'src/integrations'),
      '@modules': path.resolve(__dirname, 'modules'),
      '@web': path.resolve(__dirname, 'web/src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'modules/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    env: { MARGIN_KEYCHAIN: 'memory', MARGIN_NOTIFY: 'log' },
  },
});
