import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/decoder.test.ts', 'tests/browser/**'],
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
