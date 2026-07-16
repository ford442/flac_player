/**
 * trackCache – Cache API wrapper for offline audio track caching.
 *
 * Tracks are cached by their canonical URL. The LRU manifest is stored in
 * localStorage so we can evict the oldest entry when the cache exceeds the
 * configured byte limit.
 *
 * Usage:
 *   // Fetch (or serve from cache):
 *   const response = await getOrFetchTrack(url);
 *   const arrayBuffer = await response.arrayBuffer();
 *
 *   // Explicitly download for offline:
 *   await downloadForOffline(url, onProgress);
 *
 *   // Remove a single entry:
 *   await evictTrack(url);
 *
 *   // Remove all cached tracks:
 *   await clearTrackCache();
 */

export const TRACK_CACHE_NAME = 'flac-player-tracks-v1';
const CACHE_NAME = TRACK_CACHE_NAME;
const LRU_KEY    = 'flac_track_cache_lru';

/** Maximum total cache size in bytes (default 500 MB). */
export const MAX_CACHE_BYTES = 500 * 1024 * 1024;

export interface EvictionEvent {
  evictedUrls: string[];
  freedBytes: number;
  remainingBytes: number;
}

type EvictionListener = (event: EvictionEvent) => void;
const evictionListeners = new Set<EvictionListener>();

/** Subscribe to LRU eviction events (oldest tracks removed when over quota). */
export function onCacheEviction(listener: EvictionListener): () => void {
  evictionListeners.add(listener);
  return () => evictionListeners.delete(listener);
}

function notifyEviction(evictedUrls: string[], freedBytes: number): void {
  if (evictedUrls.length === 0) return;
  const remainingBytes = getCacheSizeBytes();
  const event: EvictionEvent = { evictedUrls, freedBytes, remainingBytes };
  evictionListeners.forEach(listener => listener(event));
}

interface LRUEntry {
  url: string;
  /** Approximate size in bytes (from Content-Length or response.body byteLength). */
  size: number;
  /** Unix timestamp of last access. */
  accessed: number;
}

// ─── LRU manifest helpers ───────────────────────────────────────────────────

function readLRU(): LRUEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LRU_KEY) || '[]') as LRUEntry[];
  } catch {
    return [];
  }
}

function writeLRU(entries: LRUEntry[]): void {
  try {
    localStorage.setItem(LRU_KEY, JSON.stringify(entries));
  } catch { /* quota exceeded – silently skip */ }
}

function touchLRU(url: string, size?: number): void {
  const entries = readLRU().filter(e => e.url !== url);
  entries.push({ url, size: size ?? 0, accessed: Date.now() });
  writeLRU(entries);
}

function removeLRU(url: string): void {
  writeLRU(readLRU().filter(e => e.url !== url));
}

// ─── Cache API availability check ────────────────────────────────────────────

function isCacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

// ─── Eviction ────────────────────────────────────────────────────────────────

/**
 * Evict oldest entries until total cached size is below MAX_CACHE_BYTES.
 * Called automatically after each cache write.
 */
async function runEviction(): Promise<void> {
  if (!isCacheAvailable()) return;

  const entries = readLRU();
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= MAX_CACHE_BYTES) return;

  // Sort by oldest access first
  const sorted = [...entries].sort((a, b) => a.accessed - b.accessed);
  let freed = 0;
  const toEvict: string[] = [];

  for (const entry of sorted) {
    if (total - freed <= MAX_CACHE_BYTES) break;
    toEvict.push(entry.url);
    freed += entry.size;
  }

  if (toEvict.length === 0) return;

  const cache = await caches.open(CACHE_NAME);
  await Promise.all(toEvict.map(url => cache.delete(url)));
  toEvict.forEach(url => removeLRU(url));
  notifyEviction(toEvict, freed);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns true if the given URL is already in the cache.
 */
export async function isTrackCached(url: string): Promise<boolean> {
  if (!isCacheAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(url);
    return match !== undefined;
  } catch {
    return false;
  }
}

/**
 * Returns the cached Response for `url` if present, otherwise fetches it from
 * the network, stores it in the cache, and returns the response.
 *
 * The returned Response is a clone so callers can read it without affecting
 * the stored copy.
 */
export async function getOrFetchTrack(url: string): Promise<Response> {
  if (!isCacheAvailable()) {
    return fetch(url);
  }

  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);

  if (cached) {
    touchLRU(url);
    return cached.clone();
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Network error: ${response.status} ${response.statusText}`);

  // Clone before storing so we can return a readable copy
  const toStore = response.clone();
  const size = parseInt(response.headers.get('content-length') ?? '0', 10);

  // Store asynchronously – don't block the caller
  cache.put(url, toStore).then(() => {
    touchLRU(url, size);
    runEviction();
  }).catch(() => { /* storage full or other error */ });

  return response;
}

/**
 * Explicitly download a track for offline use, reporting progress via an
 * optional callback. Progress is 0–1.
 */
export async function downloadForOffline(
  url: string,
  onProgress?: (progress: number) => void
): Promise<void> {
  if (!isCacheAvailable()) throw new Error('Cache API not available');

  const cache = await caches.open(CACHE_NAME);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

  const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
  const reader = response.body?.getReader();

  if (!reader || contentLength === 0) {
    // No streaming progress available – store as-is
    await cache.put(url, response.clone());
    touchLRU(url, contentLength);
    await runEviction();
    onProgress?.(1);
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
    if (contentLength > 0) onProgress?.(received / contentLength);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  const headers = new Headers(response.headers);
  const storedResponse = new Response(body, { status: 200, headers });
  await cache.put(url, storedResponse);
  touchLRU(url, received);
  await runEviction();
  onProgress?.(1);
}

/**
 * Remove a single track from the cache.
 */
export async function evictTrack(url: string): Promise<void> {
  if (!isCacheAvailable()) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(url);
  removeLRU(url);
}

/**
 * Remove all cached tracks.
 */
export async function clearTrackCache(): Promise<void> {
  if (!isCacheAvailable()) return;
  await caches.delete(CACHE_NAME);
  localStorage.removeItem(LRU_KEY);
}

/**
 * Returns the current LRU manifest entries (for display purposes).
 */
export function getCachedTrackList(): LRUEntry[] {
  return readLRU();
}

/**
 * Returns total estimated cache size in bytes.
 */
export function getCacheSizeBytes(): number {
  return readLRU().reduce((s, e) => s + e.size, 0);
}

/**
 * Record a track stored in the Cache API (e.g. after a service worker background download).
 */
export function recordCachedTrack(url: string, size: number): void {
  touchLRU(url, size);
  void runEviction();
}

/** Wire service worker download-complete messages into the LRU manifest. */
export function initTrackCacheServiceWorkerBridge(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string; size?: number } | null;
    if (!data || data.type !== 'DOWNLOAD_COMPLETE' || typeof data.url !== 'string') return;
    recordCachedTrack(data.url, typeof data.size === 'number' ? data.size : 0);
  });
}
