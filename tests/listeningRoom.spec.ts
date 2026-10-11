import { test, expect, type Page } from '@playwright/test';

/**
 * @slow Two-page listening room smoke (#209). Skipped unless ROOMS_E2E=1.
 *
 * Needs a rooms-capable API with at least one track of 2+ minutes, and the dev
 * server pointed at it:
 *   DATA_DIR=… python app.py                              # songs registered, files in DATA_DIR/music
 *   ROOMS_E2E=1 REACT_APP_API_URL=http://localhost:7860 npx playwright test tests/listeningRoom.spec.ts
 * ROOMS_E2E_SOAK_S sets the drift soak (default 30 s; acceptance run: 600).
 */

const API = process.env.REACT_APP_ROOMS_API_URL || process.env.REACT_APP_API_URL || 'http://localhost:7860';
const SOAK_S = Number(process.env.ROOMS_E2E_SOAK_S || 30);

test.skip(!process.env.ROOMS_E2E, 'Set ROOMS_E2E=1 with a rooms-capable API to run');
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

/** Remember every media element that plays (StreamingAudioPlayer keeps them off-DOM). */
function trackMediaElements() {
  const w = window as unknown as { __roomEls: Set<HTMLMediaElement> };
  w.__roomEls = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement, ...args: []) {
    w.__roomEls.add(this);
    return play.apply(this, args);
  };
}

async function clockOf(page: Page) {
  return page.evaluate(() => {
    const els = [...(window as unknown as { __roomEls: Set<HTMLMediaElement> }).__roomEls].filter((e) => e.src);
    const el = els.find((e) => !e.paused) ?? els[els.length - 1];
    return el ? { t: el.currentTime, paused: el.paused, now: performance.timeOrigin + performance.now() } : null;
  });
}

async function driftMs(host: Page, guest: Page): Promise<number> {
  const [h, g] = await Promise.all([clockOf(host), clockOf(guest)]);
  if (!h || !g) throw new Error('no playing element');
  const hostNow = h.t + (h.paused ? 0 : (g.now - h.now) / 1000);
  return (g.t - hostNow) * 1000;
}

const isPlaying = () => [...(window as unknown as { __roomEls: Set<HTMLMediaElement> }).__roomEls]
  .some((e) => !e.paused && e.currentTime > 0.2);
const allPaused = () => [...(window as unknown as { __roomEls: Set<HTMLMediaElement> }).__roomEls]
  .every((e) => e.paused);

test('@slow host and guest stay in sync; pause propagates; room ends', async ({ browser }) => {
  test.setTimeout((SOAK_S + 120) * 1000);

  const songs = await (await fetch(`${API}/api/songs`)).json() as { id: string; duration?: number; url?: string }[];
  const longest = [...songs].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
  test.skip(!longest || (longest.duration ?? 0) < SOAK_S + 30, 'API needs a track longer than the soak');
  const track = { ...longest, url: longest.url || `${API}/api/music/${longest.id}` };

  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await hostContext.addInitScript(trackMediaElements);
  await guestContext.addInitScript(trackMediaElements);
  await hostContext.addInitScript((queue) => {
    if (sessionStorage.getItem('room-e2e-seeded')) return;
    localStorage.setItem('flac_player_queue', JSON.stringify(queue));
    sessionStorage.setItem('room-e2e-seeded', '1');
  }, { tracks: [track], currentIndex: 0, shuffle: false, repeat: 'off' });

  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  host.on('dialog', (dialog) => dialog.accept());

  await host.goto('/');
  await host.getByText('🎧 Listen together').click();
  await host.waitForURL(/[?&]room=/);
  await expect(host.getByTestId('listening-room-status')).toContainText('Hosting');

  await host.keyboard.press(' ');
  await host.waitForFunction(isPlaying);

  await guest.goto(host.url());
  await guest.waitForFunction(isPlaying, null, { timeout: 20_000 });
  await expect(host.getByTestId('listening-room-status')).toContainText('1 listening');

  await guest.waitForTimeout(3000);
  const samples: number[] = [];
  for (const deadline = Date.now() + SOAK_S * 1000; Date.now() < deadline;) {
    samples.push(await driftMs(host, guest));
    await guest.waitForTimeout(5000);
  }
  expect(Math.max(...samples.map(Math.abs))).toBeLessThan(500);

  const pausedAt = Date.now();
  await host.keyboard.press(' ');
  await guest.waitForFunction(allPaused, null, { polling: 20, timeout: 5000 });
  expect(Date.now() - pausedAt).toBeLessThan(1000);

  await host.getByRole('button', { name: 'End room' }).click();
  await expect(guest.getByTestId('listening-room-panel')).toContainText('ended');

  await hostContext.close();
  await guestContext.close();
});
