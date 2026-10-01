import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockLibraryApi, stubWasmBackendImports } from './helpers/playwrightApi';

/**
 * Layer 2: real FLAC bytes through the real decode path into the real graph.
 *
 * The smoke suite mocks the API and asserts DOM; nothing there proves audio
 * actually decodes and reaches the AnalyserNode. These tests serve a committed
 * FLAC fixture, play it in a browser, and read the analyser.
 */

const TONE_FIXTURE = 'tests/fixtures/tone-5s.flac';

const TONE_TRACKS = [
  {
    id: 'tone-1',
    name: 'Tone.flac',
    title: 'Test Tone',
    author: 'Fixture',
    url: '/fixtures/tone-5s.flac',
    duration: 5,
  },
];

/**
 * Serve the fixture with Range support, so the hi-fi streaming path (which
 * probes for Accept-Ranges) can be exercised as well as buffered decode.
 */
async function serveToneFixture(page: Page): Promise<void> {
  const audio = await readFile(TONE_FIXTURE);

  await page.route('**/fixtures/tone-5s.flac**', route => {
    const rangeHeader = route.request().headers()['range'];
    if (!rangeHeader) {
      return route.fulfill({
        status: 200,
        contentType: 'audio/flac',
        headers: {
          'accept-ranges': 'bytes',
          'content-length': String(audio.length),
        },
        body: audio,
      });
    }

    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : audio.length - 1;
    const slice = audio.subarray(start, end + 1);

    return route.fulfill({
      status: 206,
      contentType: 'audio/flac',
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${audio.length}`,
        'content-length': String(slice.length),
      },
      body: slice,
    });
  });
}

/** Capture every AnalyserNode the app creates so tests can read spectrum data. */
async function captureAnalysers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OriginalAudioContext = window.AudioContext;
    const analysers: AnalyserNode[] = [];

    class TrackedAudioContext extends OriginalAudioContext {
      createAnalyser(): AnalyserNode {
        const analyser = super.createAnalyser();
        analysers.push(analyser);
        return analyser;
      }
    }

    Object.assign(window, {
      __analyserProbe: {
        analysers,
        /** Peak byte magnitude across the most recent analyser's spectrum. */
        peak() {
          const analyser = analysers[analysers.length - 1];
          if (!analyser) return -1;
          const bins = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(bins);
          return bins.reduce((max, value) => (value > max ? value : max), 0);
        },
      },
    });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: TrackedAudioContext });
  });
}

const readPeak = (page: Page) =>
  page.evaluate(() => (window as unknown as { __analyserProbe: { peak(): number } }).__analyserProbe.peak());

/** The waveform seek bar (a role="slider" div); ShaderGUI may render a second one. */
const seekSlider = (page: Page) =>
  page.getByRole('slider', { name: 'Seek position' }).filter({ visible: true }).first();

/**
 * Current playback position in seconds.
 *
 * Read from the seek slider rather than the elapsed-time label: the label is
 * formatted to whole seconds, so it cannot show sub-second progress.
 */
async function positionSeconds(page: Page): Promise<number> {
  return Number(await seekSlider(page).getAttribute('aria-valuenow'));
}

/**
 * Switch output backend via the settings tab.
 *
 * Position assertions use `worklet`: it derives currentTime from decoded
 * frames, whereas the default `streaming` backend drives an HTMLAudioElement,
 * which does not advance in headless Chromium without an audio output device.
 */
async function selectBackend(page: Page, mode: string): Promise<void> {
  await page.getByRole('button', { name: '⚙️ Settings' }).click();
  const backendSelect = page.locator('select').filter({ has: page.locator('option[value="worklet"]') }).first();
  await backendSelect.selectOption(mode);
  await page.getByRole('button', { name: '📚 Library' }).click();
}

async function openPlayerWithTone(page: Page): Promise<void> {
  await captureAnalysers(page);
  await stubWasmBackendImports(page);
  await mockLibraryApi(page, TONE_TRACKS);
  await serveToneFixture(page);
  await page.goto('/');
  // The advanced (HTML) layout exposes the transport controls these tests drive.
  await page.getByRole('button', { name: 'Open Advanced Library' }).click();
  await page.getByRole('button', { name: '📚 Library' }).click();
}

async function playTone(page: Page): Promise<void> {
  const title = page.getByText('Test Tone', { exact: true });
  await expect(title).toBeVisible({ timeout: 15_000 });
  await title.dblclick();
}

test.describe('FLAC decode → playback → analyser', () => {
  test('analyser receives non-zero spectrum data from a real FLAC file', async ({ page }) => {
    await openPlayerWithTone(page);

    // Silence before playback starts.
    await playTone(page);

    // A 440 Hz tone must register in the spectrum once audio flows.
    await expect.poll(() => readPeak(page), {
      message: 'analyser never received non-zero frequency data',
      timeout: 20000,
    }).toBeGreaterThan(0);
  });

  test('playback position advances while the fixture plays', async ({ page }) => {
    await openPlayerWithTone(page);
    await selectBackend(page, 'worklet');
    await playTone(page);

    await expect.poll(() => positionSeconds(page), {
      message: 'playback position never advanced',
      timeout: 20000,
    }).toBeGreaterThan(0.05);
  });

  test('seek moves the playback position within tolerance', async ({ page }) => {
    await openPlayerWithTone(page);
    await selectBackend(page, 'worklet');
    await playTone(page);

    // Wait for duration to be known before seeking.
    await expect.poll(async () => Number(await seekSlider(page).getAttribute('aria-valuemax')), {
      timeout: 20000,
    }).toBeGreaterThan(0);

    // The waveform maps click x-position to time: 60% of 5 s ≈ 3 s.
    const slider = seekSlider(page);
    const box = await slider.boundingBox();
    if (!box) throw new Error('seek slider has no layout box');
    await slider.click({ position: { x: box.width * 0.6, y: box.height / 2 } });

    await expect.poll(() => positionSeconds(page), {
      message: 'seek did not move the playback position',
      timeout: 10000,
    }).toBeGreaterThanOrEqual(2);

    const position = await positionSeconds(page);
    // Tolerance covers the poll interval and decoder frame granularity.
    expect(position).toBeLessThanOrEqual(5);
  });

  test('worklet backend decodes the fixture and feeds the analyser', async ({ page }) => {
    await openPlayerWithTone(page);

    await selectBackend(page, 'worklet');
    await playTone(page);

    await expect.poll(() => readPeak(page), {
      message: 'worklet path never fed the analyser',
      timeout: 20000,
    }).toBeGreaterThan(0);
  });
});
