import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  onCacheEviction,
  recordCachedTrack,
  MAX_CACHE_BYTES,
} from '../src/storage/trackCache';

describe('trackCache eviction', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();

    const store = new Map<string, unknown>();
    vi.stubGlobal('caches', {
      open: vi.fn(async () => ({
        delete: vi.fn(async (url: string) => store.delete(url)),
        match: vi.fn(async () => undefined),
        put: vi.fn(async (url: string, res: unknown) => { store.set(url, res); }),
      })),
      delete: vi.fn(async () => true),
    });
  });

  it('notifies listeners when recordCachedTrack triggers eviction over quota', async () => {
    const listener = vi.fn();
    const unsubscribe = onCacheEviction(listener);

    // Simulate two large entries exceeding the cap
    const bigSize = Math.floor(MAX_CACHE_BYTES / 2) + 1024;
    recordCachedTrack('https://example.com/a.flac', bigSize);
    recordCachedTrack('https://example.com/b.flac', bigSize);
    // Third entry should evict the oldest
    recordCachedTrack('https://example.com/c.flac', bigSize);

    // runEviction is async – give microtasks a tick
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(listener).toHaveBeenCalled();
    const event = listener.mock.calls[0][0];
    expect(event.evictedUrls.length).toBeGreaterThan(0);
    expect(event.freedBytes).toBeGreaterThan(0);

    unsubscribe();
  });
});
