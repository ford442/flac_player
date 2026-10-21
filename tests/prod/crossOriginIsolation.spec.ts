import { test, expect } from '@playwright/test';

// #259 D: the production build, served with the deploy headers, must be
// cross-origin isolated (SAB play ring, analysis tap, SDL3 pthreads), and COEP
// must not block any of the build's own assets.

test('production build is cross-origin isolated', async ({ page }) => {
  const coepBlocked: string[] = [];
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    if (/BLOCKED_BY_RESPONSE|CORP|COEP/i.test(failure)) coepBlocked.push(`${request.url()} (${failure})`);
  });

  const response = await page.goto('./');
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');

  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');

  await page.waitForLoadState('networkidle');
  expect(coepBlocked).toEqual([]);
});

test('service worker is served as JavaScript at the base path', async ({ request, baseURL }) => {
  const response = await request.get(new URL('service-worker.js', baseURL).href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/javascript/);
  expect(response.headers()['cache-control']).toBe('no-cache');
});
