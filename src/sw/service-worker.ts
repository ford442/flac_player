/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import {
  API_CACHE_NAME,
  LIBRARY_CACHE_TTL_SECONDS,
  TRACK_CACHE_NAME,
  type SWClientMessage,
  type SWServerMessage,
} from './swMessages';

declare const self: ServiceWorkerGlobalScope;

/** COEP require-corp: precached / runtime-cached same-origin assets need CORP. */
function withCorp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const corpPlugin = {
  cachedResponseWillBeUsed: async ({ cachedResponse }: { cachedResponse?: Response | null }) => {
    if (!cachedResponse) return null;
    return withCorp(cachedResponse);
  },
};

clientsClaim();
self.skipWaiting();
cleanupOutdatedCaches();

// __WB_MANIFEST is injected by workbox-webpack-plugin InjectManifest
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/],
});

// ─── Runtime caching ─────────────────────────────────────────────────────────

/** API host used in production builds (injected at compile time). */
const API_HOST: string = process.env.REACT_APP_API_URL
  ? new URL(process.env.REACT_APP_API_URL).host
  : '';

function isSongsApiRequest(url: URL): boolean {
  if (!url.pathname.startsWith('/api/songs')) return false;
  return url.origin === self.location.origin
    || (API_HOST !== '' && url.host === API_HOST);
}

registerRoute(
  ({ url, request }) => request.method === 'GET' && isSongsApiRequest(url),
  new StaleWhileRevalidate({
    cacheName: API_CACHE_NAME,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxAgeSeconds: LIBRARY_CACHE_TTL_SECONDS,
        maxEntries: 32,
      }),
      corpPlugin,
    ],
  }),
);

/** Static WASM / SDL glue – cache-first for offline SDL backends. */
registerRoute(
  ({ url, request }) => request.method === 'GET'
    && url.origin === self.location.origin
    && /\.(wasm|js)$/.test(url.pathname)
    && /\/(sdl-audio|sdl2-audio|script-processor|projectm)/.test(url.pathname),
  new CacheFirst({
    cacheName: 'flac-player-wasm-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 30 }),
      corpPlugin,
    ],
  }),
);

// ─── Background track downloads (shared Cache API store) ───────────────────

const activeDownloads = new Map<string, AbortController>();

function postToClients(message: SWServerMessage): void {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    clients.forEach(client => client.postMessage(message));
  });
}

async function downloadTrackInBackground(
  url: string,
  requestId: string,
  signal: AbortSignal
): Promise<void> {
  const cache = await caches.open(TRACK_CACHE_NAME);
  const existing = await cache.match(url);
  if (existing) {
    const size = parseInt(existing.headers.get('content-length') ?? '0', 10);
    postToClients({ type: 'DOWNLOAD_COMPLETE', requestId, url, size });
    return;
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
  const reader = response.body?.getReader();

  if (!reader || contentLength === 0) {
    await cache.put(url, response.clone());
    postToClients({ type: 'DOWNLOAD_COMPLETE', requestId, url, size: contentLength });
    return;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    postToClients({
      type: 'DOWNLOAD_PROGRESS',
      requestId,
      url,
      progress: received / contentLength,
    });
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  const headers = new Headers(response.headers);
  headers.set('content-length', String(received));
  await cache.put(url, new Response(body, { status: 200, headers }));
  postToClients({ type: 'DOWNLOAD_COMPLETE', requestId, url, size: received });
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as SWClientMessage | undefined;
  if (!data || typeof data !== 'object' || !('type' in data)) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CANCEL_DOWNLOAD') {
    activeDownloads.get(data.requestId)?.abort();
    activeDownloads.delete(data.requestId);
    return;
  }

  if (data.type === 'DOWNLOAD_TRACK') {
    const { url, requestId } = data;
    activeDownloads.get(requestId)?.abort();
    const controller = new AbortController();
    activeDownloads.set(requestId, controller);

    event.waitUntil(
      downloadTrackInBackground(url, requestId, controller.signal)
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          postToClients({ type: 'DOWNLOAD_ERROR', requestId, url, error: message });
        })
        .finally(() => {
          activeDownloads.delete(requestId);
        })
    );
  }
});
