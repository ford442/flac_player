import path from 'path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: {
    include: ['@wasm-audio-decoders/flac'],
  },
  server: {
    host: '127.0.0.1',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    include: ['tests/browser/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      api: { host: '127.0.0.1' },
      provider: playwright({
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // Software WebGPU (SwiftShader) so tests/browser/gpuFft.test.ts runs headless.
            '--enable-unsafe-webgpu',
            '--use-webgpu-adapter=swiftshader',
            '--enable-features=Vulkan',
          ],
        },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
