import { defineConfig, devices } from '@playwright/test';

/**
 * Production-build e2e (#259 D): serves the built dist/ with the headers from
 * vercel.json (scripts/serve-dist.mjs) and checks the page is cross-origin
 * isolated. Build first: `npm run build && npm run test:e2e:prod`.
 * Set PUBLIC_PATH to the value the build used to test a subpath deploy.
 */
const PORT = Number(process.env.PROD_E2E_PORT || 4173);
const BASE = (process.env.PUBLIC_PATH || '/').replace(/\/?$/, '/');

export default defineConfig({
  testDir: './tests/prod',
  testMatch: '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}${BASE}`,
    trace: 'retain-on-first-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    url: `http://localhost:${PORT}${BASE}`,
    env: { PORT: String(PORT), PUBLIC_PATH: BASE },
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
