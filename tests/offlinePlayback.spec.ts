import { test, expect } from '@playwright/test';

// Network-off playback of a cached non-FLAC track through the service worker.
// The SW only exists in production builds, so this runs against PW_PROD_URL
// (e.g. `npm run build && npx serve -s dist -l 4173`, PW_PROD_URL=http://localhost:4173).
const PROD_URL = process.env.PW_PROD_URL;

test.skip(!PROD_URL, 'PW_PROD_URL not set — needs a production build with service-worker.js');

test('cached wav plays with the network off', async ({ page, context }) => {
  await page.goto(PROD_URL!);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // First load is not controlled until clientsClaim; reload to be sure.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  const trackUrl = await page.evaluate(async () => {
    // 1 s of 440 Hz mono 16-bit WAV
    const rate = 8000;
    const n = rate;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 440 * i / rate) * 8000, true);

    const url = new URL('/files/audio/music/offline-e2e.wav', location.origin).href;
    const cache = await caches.open('flac-player-tracks-v1');
    await cache.put(url, new Response(buf, {
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(buf.byteLength) },
    }));
    return url;
  });

  await context.setOffline(true);

  const ranged = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Range: 'bytes=0-43' } });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength };
  }, trackUrl);
  expect(ranged).toEqual({ status: 206, len: 44 });

  const played = await page.evaluate(async (url) => {
    const audio = new Audio();
    audio.muted = true;
    audio.src = url;
    await audio.play();
    await new Promise(r => setTimeout(r, 300));
    return { time: audio.currentTime, error: audio.error?.code ?? null };
  }, trackUrl);
  expect(played.error).toBeNull();
  expect(played.time).toBeGreaterThan(0);
});
