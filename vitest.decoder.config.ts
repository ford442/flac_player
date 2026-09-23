import { defineConfig } from 'vitest/config';

/** Isolated config for WASM-heavy decoder fixture test (node env, no jsdom). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/decoder.test.ts', 'tests/flacSeek.test.ts', 'tests/resampler.test.ts'],
    globals: true,
    pool: 'forks',
    maxWorkers: 1,
  },
});
