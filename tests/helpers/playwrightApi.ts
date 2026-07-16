import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export const MOCK_TRACKS = [
  {
    id: 'track-1',
    name: 'Track One.flac',
    title: 'Track One',
    author: 'Test Artist',
    url: '/fixtures/test.flac',
    duration: 1,
  },
  {
    id: 'track-2',
    name: 'Track Two.flac',
    title: 'Track Two',
    author: 'Test Artist',
    url: '/fixtures/test-two.flac',
    duration: 1,
  },
];

/** Mock library/health API routes used on app startup. */
export async function mockLibraryApi(page: Page, tracks = MOCK_TRACKS): Promise<void> {
  await page.route('**/api/songs/tags**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/songs/stats**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total_tracks: tracks.length,
        rated_4plus: 0,
        total_duration_hours: 0,
        total_play_count: 0,
        untagged_count: 0,
        trash_count: 0,
        unique_tags: 0,
        top_tags: [],
      }),
    })
  );
  await page.route('**/api/songs?**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tracks) })
  );
  await page.route('**/api/songs', route => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tracks) });
  });
}

/** Serve short FLAC fixtures for streaming/worklet tests. */
export async function mockAudioFixtures(page: Page): Promise<void> {
  const flac = await readFile('tests/fixtures/test.flac');
  await page.route('**/fixtures/test.flac**', route =>
    route.fulfill({ status: 200, contentType: 'audio/flac', body: flac })
  );
  await page.route('**/fixtures/test-two.flac**', route =>
    route.fulfill({ status: 200, contentType: 'audio/flac', body: flac })
  );
}

/** Stub SDL WASM dynamic imports so backend dropdown tests never fetch Emscripten glue. */
export async function stubWasmBackendImports(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noopModule = {
      _malloc: () => 0,
      _free: () => {},
      _set_audio_data: () => {},
      _play: () => {},
      _pause: () => {},
      _stop: () => {},
      _seek: () => {},
      _set_volume: () => {},
      _get_pcm_ring_state: () => 0,
      _get_pcm_ring_data: () => 0,
      HEAPF32: new Float32Array(0),
      HEAPU8: new Uint8Array(0),
    };

    const originalImport = window.__webpack_chunk_load__ as ((id: string) => Promise<void>) | undefined;

    // Webpack 5 uses __webpack_chunk_load__ for async chunks; stub SDL chunk URLs.
    (window as unknown as { __webpack_chunk_load__: (id: string) => Promise<void> }).__webpack_chunk_load__ =
      async (chunkId: string) => {
        if (typeof chunkId === 'string' && /sdl/i.test(chunkId)) return;
        if (originalImport) return originalImport(chunkId);
      };

    // Prevent failed script loads from blocking tests when chunks are requested by URL.
    const OriginalScript = window.HTMLScriptElement.prototype.constructor as typeof HTMLScriptElement;
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof OriginalScript && node.src.match(/sdl/i)) {
            node.dispatchEvent(new Event('load'));
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    Object.assign(window, { __testWasmStub: noopModule });
  });
}
