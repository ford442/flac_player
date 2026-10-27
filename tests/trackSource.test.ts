import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PlaylistTrack } from '../src/types/library';
import { isLibraryTrack, trackSource } from '../src/types/track';
import { trackFromUrl } from '../src/utils/remoteTracks';
import { insertTrackNextForPlayback, queueTrackForPlayback } from '../src/utils/queueUtils';
import { isShareableTrackId } from '../src/listening/useListeningRoomBridge';
import { recordPlay, trashTrack, updateSampleMetadata } from '../src/api/songApi';

const t = (id: string): PlaylistTrack => ({ id, name: id, url: `https://storage.test/${id}.flac` });

describe('track source (#258 bug 11)', () => {
  it('marks URL tracks and classifies legacy ids without a source', () => {
    const url = trackFromUrl('https://example.test/a%20b.mp3')!;
    expect(url.source).toBe('url');
    expect(isLibraryTrack(url)).toBe(false);
    expect(trackSource({ id: 'url:https://example.test/x.flac' })).toBe('url');
    expect(trackSource({ id: 'local-123-abc' })).toBe('local');
    expect(trackSource({ id: '7f3c' })).toBe('library');
    expect(trackSource({ id: 'url:https://x.test/y', source: 'library' })).toBe('library');
  });

  it('keeps URL and local tracks out of listening rooms', () => {
    expect(isShareableTrackId('7f3c')).toBe(true);
    expect(isShareableTrackId('url:https://example.test/a.mp3')).toBe(false);
    expect(isShareableTrackId('local-1-x')).toBe(false);
    expect(isShareableTrackId('')).toBe(false);
  });
});

describe('song API ids are path-encoded (#258 bug 11)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('never puts a raw id with / or : into the path', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const id = 'url:https://example.test/a b.mp3';
    await recordPlay(id);
    await updateSampleMetadata(id, { rating: 3 });
    await trashTrack(id);
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      const path = new URL(url).pathname;
      expect(path).toContain(encodeURIComponent(id));
      expect(path).not.toContain('https://');
    }
  });
});

describe('queue slot for a clicked track (#258 bug 7)', () => {
  it('plays an already-queued track from its own index', () => {
    const queue = [t('a'), t('b'), t('c')];
    const result = queueTrackForPlayback(queue, t('b'));
    expect(result.index).toBe(1);
    expect(result.queue).toBe(queue);
  });

  it('appends a new track and plays it from the end', () => {
    const queue = [t('a'), t('b')];
    const result = queueTrackForPlayback(queue, t('c'));
    expect(result.index).toBe(2);
    expect(result.queue.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('inserts a pasted link after the current track instead of replacing the queue', () => {
    const queue = [t('a'), t('b'), t('c')];
    const link = trackFromUrl('https://example.test/x.mp3')!;
    const result = insertTrackNextForPlayback(queue, link, 0);
    expect(result.queue.map((x) => x.id)).toEqual(['a', link.id, 'b', 'c']);
    expect(result.index).toBe(1);
    expect(insertTrackNextForPlayback(result.queue, link, 2).index).toBe(1);
    expect(insertTrackNextForPlayback([], link, -1)).toEqual({ queue: [link], index: 0 });
  });
});
