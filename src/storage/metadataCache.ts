// Parsed track metadata persisted across reloads.
//
// Tags + specs (small JSON) live in localStorage; embedded cover art lives in the Cache API
// (blobs do not belong in the 5 MB localStorage quota). Entries expire with the library cache
// TTL and are LRU-evicted past MAX_ENTRIES.

import type { TrackMetadata, TrackSpecs, TrackTags } from '../utils/trackMetadata';

export const METADATA_CACHE_KEY = 'flac_player_track_metadata';
export const METADATA_ARTWORK_CACHE_NAME = 'flac-player-artwork-v1';
/** Entries older than a day are re-read from the file. */
export const METADATA_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
export const METADATA_CACHE_MAX_ENTRIES = 300;
export const METADATA_ARTWORK_MAX_BYTES = 4 * 1024 * 1024;

/** Skip rewriting localStorage just to bump the LRU stamp on frequent reads. */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

interface StoredEntry {
  tags: TrackTags;
  specs: TrackSpecs;
  /** MIME type when cover art is stored in the artwork cache. */
  artMime?: string;
  cachedAt: number;
  accessed: number;
}

interface Store {
  version: 1;
  entries: Record<string, StoredEntry>;
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(METADATA_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed;
    }
  } catch {
    /* corrupt or unavailable: start fresh */
  }
  return { version: 1, entries: {} };
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(store));
  } catch {
    /* quota exceeded or storage blocked: cache is best-effort */
  }
}

function artworkRequest(key: string): Request | null {
  if (typeof location === 'undefined') return null;
  try {
    return new Request(new URL(`/__track-artwork__/${encodeURIComponent(key)}`, location.origin).href);
  } catch {
    return null;
  }
}

async function openArtworkCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(METADATA_ARTWORK_CACHE_NAME);
  } catch {
    return null;
  }
}

async function deleteArtwork(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const cache = await openArtworkCache();
  if (!cache) return;
  await Promise.all(keys.map(async (key) => {
    const req = artworkRequest(key);
    if (req) await cache.delete(req).catch(() => false);
  }));
}

/**
 * Persisted metadata for `key`, or null when missing/expired/incomplete.
 * An entry that claims cover art but whose art is gone counts as a miss so it gets re-parsed.
 */
export async function getPersistedMetadata(key: string): Promise<TrackMetadata | null> {
  const store = readStore();
  const entry = store.entries[key];
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.cachedAt > METADATA_CACHE_TTL_MS) {
    delete store.entries[key];
    writeStore(store);
    void deleteArtwork([key]);
    return null;
  }

  let picture: TrackMetadata['picture'];
  if (entry.artMime) {
    const cache = await openArtworkCache();
    const req = artworkRequest(key);
    const hit = cache && req ? await cache.match(req).catch(() => undefined) : undefined;
    if (!hit) return null;
    picture = { mime: entry.artMime, data: new Uint8Array(await hit.arrayBuffer()) };
  }

  if (now - entry.accessed > TOUCH_INTERVAL_MS) {
    entry.accessed = now;
    writeStore(store);
  }
  return { tags: entry.tags, specs: entry.specs, picture };
}

/** Best-effort persist; silently skips when storage is unavailable or the art is too large. */
export async function persistMetadata(key: string, meta: TrackMetadata): Promise<void> {
  let artMime: string | undefined;
  if (meta.picture) {
    if (meta.picture.data.byteLength > METADATA_ARTWORK_MAX_BYTES) return;
    const cache = await openArtworkCache();
    const req = artworkRequest(key);
    if (!cache || !req) return;
    try {
      await cache.put(req, new Response(meta.picture.data as BodyInit, {
        headers: { 'content-type': meta.picture.mime },
      }));
    } catch {
      return;
    }
    artMime = meta.picture.mime;
  }

  const now = Date.now();
  const store = readStore();
  store.entries[key] = { tags: meta.tags, specs: meta.specs, artMime, cachedAt: now, accessed: now };

  const keys = Object.keys(store.entries);
  if (keys.length > METADATA_CACHE_MAX_ENTRIES) {
    const evict = keys
      .sort((a, b) => store.entries[a]!.accessed - store.entries[b]!.accessed)
      .slice(0, keys.length - METADATA_CACHE_MAX_ENTRIES);
    for (const k of evict) delete store.entries[k];
    void deleteArtwork(evict);
  }
  writeStore(store);
}

export async function clearMetadataCache(): Promise<void> {
  try {
    localStorage.removeItem(METADATA_CACHE_KEY);
  } catch {
    /* storage blocked */
  }
  if (typeof caches === 'undefined') return;
  await caches.delete(METADATA_ARTWORK_CACHE_NAME).catch(() => false);
}
