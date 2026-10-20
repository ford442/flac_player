import { useEffect, useState } from 'react';
import { getPersistedMetadata, persistMetadata } from '../storage/metadataCache';
import {
  loadLocalTrackMetadata,
  loadRemoteTrackMetadata,
  type TrackMetadata,
} from '../utils/trackMetadata';

export interface TrackMetadataSource {
  /** Stable per-track key (library id or URL). */
  cacheKey: string;
  url?: string;
  /** Local file for this track; ignored unless `url` is a blob: URL (see `ownsFile`). */
  file?: File;
}

const MEMORY_CACHE_MAX = 20;
const memoryCache = new Map<string, TrackMetadata>();
const inflight = new Map<string, Promise<TrackMetadata | null>>();

/**
 * `currentFile` in the playback controller is never cleared when a remote track starts,
 * so a File only describes the track whose URL is the object URL created for it.
 */
export function ownsFile(url: string | undefined, file: File | undefined): file is File {
  return !!file && (!url || url.startsWith('blob:'));
}

function remember(key: string, meta: TrackMetadata): void {
  memoryCache.delete(key);
  memoryCache.set(key, meta);
  if (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
}

async function loadUncached(source: TrackMetadataSource): Promise<TrackMetadata | null> {
  const { cacheKey, url, file } = source;

  if (ownsFile(url, file)) {
    // Local files are cheap to re-parse and their key is per-load, so never persisted.
    return loadLocalTrackMetadata(file);
  }
  if (!url || !/^https?:/i.test(url)) return null;

  const persisted = await getPersistedMetadata(cacheKey);
  if (persisted) return persisted;

  const fresh = await loadRemoteTrackMetadata(url);
  if (fresh) void persistMetadata(cacheKey, fresh);
  return fresh;
}

/**
 * Memory → persisted → network. Concurrent callers for one key share a single load
 * (the Now Playing view and the transport bar both ask for the current track).
 */
export function getTrackMetadata(source: TrackMetadataSource): Promise<TrackMetadata | null> {
  const hit = memoryCache.get(source.cacheKey);
  if (hit) {
    remember(source.cacheKey, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(source.cacheKey);
  if (pending) return pending;

  const load = loadUncached(source)
    .then((meta) => {
      if (meta) remember(source.cacheKey, meta);
      return meta;
    })
    .catch((err) => {
      console.warn('Metadata load failed', err);
      return null;
    })
    .finally(() => { inflight.delete(source.cacheKey); });
  inflight.set(source.cacheKey, load);
  return load;
}

/** Test hook: forget in-memory state (persisted state is cleared via clearMetadataCache). */
export function resetTrackMetadataMemory(): void {
  memoryCache.clear();
  inflight.clear();
}

export interface UseTrackMetadataResult {
  metadata: TrackMetadata | null;
  /** Object URL for embedded cover art (revoked automatically). */
  artworkUrl: string | null;
  isLoading: boolean;
}

/** Tags, specs and cover art for a track, without downloading the whole audio file. */
export function useTrackMetadata(source: TrackMetadataSource | null): UseTrackMetadataResult {
  const cacheKey = source?.cacheKey;
  const url = source?.url;
  const file = source?.file;

  const [state, setState] = useState<{ key?: string; metadata: TrackMetadata | null; artworkUrl: string | null }>({
    metadata: null,
    artworkUrl: null,
  });

  useEffect(() => {
    if (!cacheKey) {
      setState({ metadata: null, artworkUrl: null });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;

    void getTrackMetadata({ cacheKey, url, file }).then((metadata) => {
      if (cancelled) return;
      if (metadata?.picture) {
        objectUrl = URL.createObjectURL(
          new Blob([metadata.picture.data as BlobPart], { type: metadata.picture.mime })
        );
      }
      setState({ key: cacheKey, metadata, artworkUrl: objectUrl });
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cacheKey, url, file]);

  // Results that belong to a previous track must not flash under the new one.
  const current = state.key === cacheKey;
  return {
    metadata: current ? state.metadata : null,
    artworkUrl: current ? state.artworkUrl : null,
    isLoading: !!cacheKey && !current,
  };
}
