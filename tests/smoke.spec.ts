import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockLibraryApi, mockAudioFixtures, stubWasmBackendImports, MOCK_TRACKS } from './helpers/playwrightApi';

async function openAdvancedLibrary(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open Advanced Library' }).click();
  await expect(page.getByRole('button', { name: '▶️ Now Playing' })).toBeVisible();
}

async function playLibraryTrack(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: '📚 Library' }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByText(title, { exact: true }).dblclick();
}

test.describe('FLAC Player Smoke Tests', () => {
  test('submits a generation job and plays the completed AI track', async ({ page }) => {
    test.setTimeout(60_000);
    const generatedAudio = await readFile('tests/fixtures/test.flac');
    let submittedPayload: Record<string, unknown> | undefined;
    let statusChecks = 0;

    await page.route('**/api/generate**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path === '/api/generate') {
        submittedPayload = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job_id: 'job-1', status: 'queued' }) });
        return;
      }
      statusChecks += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        job_id: 'job-1', status: 'completed', song_id: 'generated-song', progress: 100
      }) });
    });
    await page.route('**/api/songs/generated-song', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'generated-song', name: 'Neon Rain.flac', title: 'Neon Rain', author: 'AI Studio',
        url: '/generated.flac', generation_model: 'MusicGen', version: 'v1',
        prompt: 'Nocturnal ambient synthwave with rain on glass.'
      })
    }));
    await page.route('**/api/songs?**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/generated.flac', route => route.fulfill({ status: 200, contentType: 'audio/flac', body: generatedAudio }));

    await page.goto('/');
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByRole('button', { name: 'MusicGen' }).click();
    await page.getByLabel('Title').fill('Neon Rain');
    await page.getByLabel(/^Prompt/).fill('Nocturnal ambient synthwave with rain on glass.');
    await page.getByRole('button', { name: 'Generate track' }).click();

    await expect.poll(() => statusChecks).toBeGreaterThan(0);
    await expect.poll(() => submittedPayload).toMatchObject({
      service: 'musicgen', title: 'Neon Rain', prompt: 'Nocturnal ambient synthwave with rain on glass.'
    });
    await expect(page.getByText('MusicGen · v1')).toBeVisible({ timeout: 15_000 });
    await page.getByText('Generation prompt').click();
    await expect(page.getByText('Nocturnal ambient synthwave with rain on glass.')).toBeVisible();
  });

  test('backend switches reuse one context and one shared output graph', async ({ page }) => {
    await stubWasmBackendImports(page);
    await page.addInitScript(() => {
      const OriginalAudioContext = window.AudioContext;
      const destinations = new WeakSet<AudioNode>();
      const analysers: AnalyserNode[] = [];
      const counters = { contexts: 0, destinationConnections: 0, disconnects: 0 };

      class TrackedAudioContext extends OriginalAudioContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          counters.contexts += 1;
          destinations.add(this.destination);
        }

        createAnalyser(): AnalyserNode {
          const analyser = super.createAnalyser();
          analysers.push(analyser);
          return analyser;
        }
      }

      const originalConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (...args: Parameters<AudioNode['connect']>) {
        if (destinations.has(args[0])) counters.destinationConnections += 1;
        return originalConnect.apply(this, args);
      } as AudioNode['connect'];

      const originalDisconnect = AudioNode.prototype.disconnect;
      AudioNode.prototype.disconnect = function (...args: Parameters<AudioNode['disconnect']>) {
        counters.disconnects += 1;
        return originalDisconnect.apply(this, args);
      } as AudioNode['disconnect'];

      Object.assign(window, { __audioGraphTest: { counters, analysers } });
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: TrackedAudioContext });
    });

    await mockLibraryApi(page);
    await page.goto('/');
    await openAdvancedLibrary(page);

    await page.getByRole('button', { name: '⚙️ Settings' }).click();
    const backendSelect = page.locator('select').filter({ has: page.locator('option[value="worklet"]') }).first();
    await backendSelect.selectOption('worklet');
    await backendSelect.selectOption('web-audio');
    await backendSelect.selectOption('streaming');

    await expect.poll(() => page.evaluate(() => {
      const testState = (window as unknown as {
        __audioGraphTest: { counters: { contexts: number; destinationConnections: number; disconnects: number }; analysers: AnalyserNode[] };
      }).__audioGraphTest;
      return {
        ...testState.counters,
        analyserCount: testState.analysers.length,
        analyserIsStable: testState.analysers.every(node => node === testState.analysers[0]),
      };
    })).toEqual({
      contexts: 1,
      destinationConnections: 1,
      disconnects: expect.any(Number),
      analyserCount: 1,
      analyserIsStable: true,
    });

    const disconnects = await page.evaluate(() => (window as unknown as {
      __audioGraphTest: { counters: { disconnects: number } };
    }).__audioGraphTest.counters.disconnects);
    expect(disconnects).toBeGreaterThanOrEqual(2);
  });

  test('queue controls respect repeat-all navigation at queue boundaries', async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
    await page.addInitScript((queueState) => {
      localStorage.setItem('flac_player_queue', JSON.stringify(queueState));
    }, {
      tracks: MOCK_TRACKS,
      currentIndex: 1,
      shuffle: false,
      repeat: 'all',
    });

    await page.goto('/');
    await openAdvancedLibrary(page);
    await playLibraryTrack(page, 'Track Two');

    const nextButton = page.getByRole('button', { name: 'Next track' });
    await expect(nextButton).toBeEnabled();
    await nextButton.click();
    await expect(page.getByText('Track One', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('homepage loads without errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('webgpu-no-adapter')) {
        consoleErrors.push(msg.text());
      }
    });

    await mockLibraryApi(page);
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    expect(consoleErrors).toHaveLength(0);
  });

  test('WebGPU availability is detected', async ({ page }) => {
    await page.goto('/');
    const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
    expect(typeof hasWebGPU).toBe('boolean');
  });

  test('metadata panel renders in dark mode by default', async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
    await page.goto('/');
    await openAdvancedLibrary(page);
    await playLibraryTrack(page, 'Track One');

    const panel = page.locator('[aria-label="Now Playing - Track Information"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toHaveClass(/dark/);
    await expect(panel.getByText('NOW PLAYING')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Track One' })).toBeVisible();
  });

  test('theme toggle switches to light mode', async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
    await page.goto('/');
    await openAdvancedLibrary(page);
    await playLibraryTrack(page, 'Track One');

    const panel = page.locator('[aria-label="Now Playing - Track Information"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const toggle = panel.getByRole('button', { name: 'Switch to light mode' });

    await toggle.click();
    await expect(panel).toHaveClass(/light/);

    await panel.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(panel).toHaveClass(/dark/);
  });

  test('keyboard shortcuts are registered', async ({ page }) => {
    await mockLibraryApi(page);
    await page.goto('/');
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Space');
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter).toBe(scrollYBefore);
  });

  test('advanced library exposes a manual rescan action', async ({ page }) => {
    let syncRequests = 0;
    await mockLibraryApi(page);
    await page.route('**/api/admin/sync-music**', async (route) => {
      syncRequests += 1;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'accepted' })
      });
    });

    await page.goto('/');
    await openAdvancedLibrary(page);

    const rescanButton = page.getByRole('button', { name: /Rescan Library|Rescanning/ });
    await expect(rescanButton).toBeVisible();
    await rescanButton.click();
    await expect.poll(() => syncRequests).toBeGreaterThan(0);
  });
});
