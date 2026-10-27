import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWindowedSource,
  formatSpecBadges,
  id3v2TagLength,
  loadLocalTrackMetadata,
  loadRemoteTrackMetadata,
  loadTrackMetadataFromSource,
  readFlacMetadataBlocks,
  type ByteSource,
} from '../src/utils/trackMetadata';
import {
  METADATA_CACHE_KEY,
  METADATA_CACHE_MAX_ENTRIES,
  METADATA_CACHE_TTL_MS,
  clearMetadataCache,
  getPersistedMetadata,
  persistMetadata,
} from '../src/storage/metadataCache';
import { getTrackMetadata, ownsFile, resetTrackMetadataMemory } from '../src/hooks/useTrackMetadata';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(fixturesDir, name)));

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u32le(n: number): number[] {
  return u32be(n).reverse();
}
function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}
function block(type: number, body: Uint8Array | number[], isLast = false): Uint8Array {
  const len = body.length;
  const out = new Uint8Array(4 + len);
  out[0] = (isLast ? 0x80 : 0) | type;
  out[1] = (len >> 16) & 0xff;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(body, 4);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function vorbisComment(fields: Record<string, string>): number[] {
  const vendor = ascii('test');
  const entries = Object.entries(fields).map(([k, v]) => ascii(`${k}=${v}`));
  return [
    ...u32le(vendor.length), ...vendor,
    ...u32le(entries.length),
    ...entries.flatMap((e) => [...u32le(e.length), ...e]),
  ];
}
function pictureBody(mime: string, data: Uint8Array): Uint8Array {
  const m = ascii(mime);
  return concat(
    new Uint8Array([...u32be(3), ...u32be(m.length), ...m, ...u32be(0), ...u32be(8), ...u32be(8), ...u32be(24), ...u32be(0)]),
    new Uint8Array(u32be(data.length)),
    data
  );
}

/** test.flac's STREAMINFO + audio frames, re-wrapped with big tag blocks and a long audio tail. */
function buildBigTaggedFlac() {
  const src = fixture('test.flac');
  const streamInfo = src.slice(8, 8 + 34);
  // Audio starts after the fixture's own metadata blocks.
  let offset = 4;
  for (;;) {
    const isLast = (src[offset]! & 0x80) !== 0;
    offset += 4 + ((src[offset + 1]! << 16) | (src[offset + 2]! << 8) | src[offset + 3]!);
    if (isLast) break;
  }
  const audio = src.slice(offset);
  const cover = new Uint8Array(200 * 1024).fill(0xab);
  const tail = new Uint8Array(3 * 1024 * 1024).fill(0x55);

  const header = concat(
    new Uint8Array(ascii('fLaC')),
    block(0, streamInfo),
    block(4, vorbisComment({ TITLE: 'Big Tagged', ARTIST: 'The Ranged', ALBUM: 'Header Only', DATE: '2019' })),
    block(1, new Uint8Array(1024 * 1024)), // 1 MB PADDING: must never be downloaded
    block(6, pictureBody('image/png', cover), true)
  );
  const file = concat(header, audio, tail);
  return { file, audioOffset: header.length, cover };
}

/** Remote-like source that counts every byte it hands out. */
function countingSource(data: Uint8Array) {
  let served = 0;
  const fetchRange = async (start: number, end: number) => {
    const slice = data.slice(start, Math.min(end, data.length));
    served += slice.length;
    return slice;
  };
  return { fetchRange, served: () => served };
}

async function remoteStyleSource(data: Uint8Array) {
  const counter = countingSource(data);
  const first = await counter.fetchRange(0, 128 * 1024);
  const src = createWindowedSource(counter.fetchRange, { start: 0, bytes: first });
  return { src, served: counter.served };
}

describe('readFlacMetadataBlocks / loadTrackMetadataFromSource', () => {
  it('reads tags, cover and specs from a large FLAC without touching padding or audio', async () => {
    const { file, audioOffset, cover } = buildBigTaggedFlac();
    const { src, served } = await remoteStyleSource(file);

    const meta = await loadTrackMetadataFromSource(src, () => file.length);

    expect(meta?.tags).toMatchObject({ title: 'Big Tagged', artist: 'The Ranged', album: 'Header Only', year: 2019 });
    expect(meta?.specs.sampleRate).toBe(44100);
    expect(meta?.specs.duration).toBeCloseTo(1, 1);
    expect(meta?.picture?.mime).toBe('image/png');
    expect(meta?.picture?.data.length).toBe(cover.length);
    // Bitrate is derived from the real file size, not the trimmed buffer the parser saw.
    expect(meta?.specs.bitrate).toBeCloseTo((8 * (file.length - audioOffset)) / meta!.specs.duration!, 0);

    expect(file.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(served()).toBeLessThan(cover.length + 256 * 1024); // first window + read-ahead + the cover itself
  });

  it('marks the last kept block when the original last block (padding) is dropped', async () => {
    const src = fixture('test.flac');
    const flac = await readFlacMetadataBlocks({ read: async (s, e) => src.slice(s, e) });
    expect(flac).not.toBeNull();
    let offset = 4;
    let lastFlags = 0;
    while (offset < flac!.bytes.length) {
      lastFlags += (flac!.bytes[offset]! & 0x80) !== 0 ? 1 : 0;
      offset += 4 + ((flac!.bytes[offset + 1]! << 16) | (flac!.bytes[offset + 2]! << 8) | flac!.bytes[offset + 3]!);
    }
    expect(lastFlags).toBe(1);
    expect(offset).toBe(flac!.bytes.length);
  });

  it('parses the plain fixtures: FLAC, WAV (header duration kept) and MP3 (duration dropped)', async () => {
    for (const [name, check] of [
      ['test.flac', (m: NonNullable<Awaited<ReturnType<typeof loadTrackMetadataFromSource>>>) => {
        expect(m.tags.title).toBe('Fixture FLAC');
        expect(m.specs.sampleRate).toBe(44100);
        expect(m.specs.duration).toBeCloseTo(1, 2);
      }],
      ['test.wav', (m: NonNullable<Awaited<ReturnType<typeof loadTrackMetadataFromSource>>>) => {
        expect(m.tags.title).toBe('Test Track');
        expect(m.specs.duration).toBeCloseTo(0.25, 2);
      }],
      ['test.mp3', (m: NonNullable<Awaited<ReturnType<typeof loadTrackMetadataFromSource>>>) => {
        expect(m.specs.sampleRate).toBeGreaterThan(0);
        expect(m.specs.duration).toBeUndefined();
        expect(m.specs.bitrate).toBeUndefined();
      }],
    ] as const) {
      const data = fixture(name);
      const { src } = await remoteStyleSource(data);
      const meta = await loadTrackMetadataFromSource(src, () => data.length, `/files/${name}`);
      expect(meta, name).not.toBeNull();
      check(meta!);
    }
  });

  it('rejects non-audio data so callers can fall back to backend fields', async () => {
    const junk = new Uint8Array(4096).fill(7);
    const { src } = await remoteStyleSource(junk);
    await expect(loadTrackMetadataFromSource(src, () => junk.length)).rejects.toBeDefined();
  });

  it('loads a local File with parseBlob', async () => {
    const file = new File([fixture('test.flac') as BlobPart], 'test.flac', { type: 'audio/flac' });
    const meta = await loadLocalTrackMetadata(file);
    expect(meta.tags.title).toBe('Fixture FLAC');
  });
});

describe('id3v2TagLength', () => {
  it('decodes the syncsafe size and footer flag', () => {
    const head = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0x02, 0x01]); // size = 2*128 + 1 = 257
    expect(id3v2TagLength(head)).toBe(10 + 257 + 10);
    head[5] = 0;
    expect(id3v2TagLength(head)).toBe(10 + 257);
    expect(id3v2TagLength(new Uint8Array(20))).toBe(0);
  });
});

describe('formatSpecBadges', () => {
  it('formats the technical specs and tolerates missing data', () => {
    expect(formatSpecBadges({ container: 'FLAC', sampleRate: 44100, bitsPerSample: 16, channels: 2, bitrate: 987654 }))
      .toEqual(['FLAC', '44.1 kHz', '16-bit', 'Stereo', '988 kbps']);
    expect(formatSpecBadges(null)).toEqual([]);
    expect(formatSpecBadges({})).toEqual([]);
  });
});

// ─── Remote loading through fetch ───────────────────────────────────────────

function mockServer(data: Uint8Array, opts: { honorRange: boolean }) {
  const stats = { requests: 0, bytesPulled: 0, ranges: [] as string[] };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    stats.requests++;
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    stats.ranges.push(range ?? '');
    const match = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    const [start, end] = match && opts.honorRange
      ? [parseInt(match[1]!, 10), Math.min(parseInt(match[2]!, 10) + 1, data.length)]
      : [0, data.length];
    if (opts.honorRange && start >= data.length) return new Response(null, { status: 416 });

    let pos = start;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos >= end) return controller.close();
        const next = Math.min(pos + 32 * 1024, end);
        stats.bytesPulled += next - pos;
        controller.enqueue(data.slice(pos, next));
        pos = next;
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: opts.honorRange ? 206 : 200,
      headers: opts.honorRange
        ? { 'content-range': `bytes ${start}-${end - 1}/${data.length}` }
        : { 'content-length': String(data.length) },
    });
  });
  return { fetchMock, stats };
}

describe('loadRemoteTrackMetadata', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('uses Range requests and never pulls the whole file', async () => {
    const { file } = buildBigTaggedFlac();
    const { fetchMock, stats } = mockServer(file, { honorRange: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const meta = await loadRemoteTrackMetadata('https://storage.example.com/files/audio/music/big.flac');

    expect(meta?.tags.title).toBe('Big Tagged');
    expect(meta?.picture).toBeDefined();
    expect(stats.ranges.every((r) => r.startsWith('bytes='))).toBe(true);
    expect(stats.bytesPulled).toBeLessThan(file.length / 8);
    // Content-Range total gives a real bitrate (~ file size over 1 s of audio).
    expect(meta?.specs.bitrate).toBeGreaterThan(8 * 3 * 1024 * 1024);
  });

  it('stops reading the body when the server ignores Range and answers 200', async () => {
    const { file } = buildBigTaggedFlac();
    const { fetchMock, stats } = mockServer(file, { honorRange: false });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const meta = await loadRemoteTrackMetadata('https://storage.example.com/big.flac');

    expect(meta?.tags.title).toBe('Big Tagged');
    // Reading stops once each window is satisfied; buffering whole bodies would pull ~file.length per request.
    expect(stats.bytesPulled).toBeLessThan(file.length * 2);
    expect(stats.bytesPulled / stats.requests).toBeLessThan(file.length / 2);
  });

  it('resolves null for unparseable data and propagates abort', async () => {
    const junk = new Uint8Array(2048).fill(9);
    globalThis.fetch = mockServer(junk, { honorRange: true }).fetchMock as unknown as typeof fetch;
    expect(await loadRemoteTrackMetadata('https://x.test/a.bin')).toBeNull();

    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(loadRemoteTrackMetadata('https://x.test/a.flac', controller.signal)).rejects.toThrow();
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

class FakeCache {
  store = new Map<string, Response>();
  async put(req: Request, res: Response) { this.store.set(req.url, res); }
  async match(req: Request) { return this.store.get(req.url)?.clone(); }
  async delete(req: Request) { return this.store.delete(req.url); }
}

function installFakeCaches() {
  const cache = new FakeCache();
  const caches = {
    open: vi.fn(async () => cache),
    delete: vi.fn(async () => { cache.store.clear(); return true; }),
  };
  vi.stubGlobal('caches', caches);
  return cache;
}

const sampleMeta = (withPicture: boolean) => ({
  tags: { title: 'T', artist: 'A', album: 'Al', year: 2020, trackNo: 3 },
  specs: { sampleRate: 96000, bitsPerSample: 24, channels: 2, container: 'FLAC', bitrate: 2_000_000, duration: 200 },
  picture: withPicture ? { mime: 'image/jpeg', data: new Uint8Array([1, 2, 3, 4]) } : undefined,
});

describe('metadataCache persistence', () => {
  let cache: FakeCache;
  beforeEach(() => { cache = installFakeCaches(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('round-trips tags, specs and cover art', async () => {
    await persistMetadata('song-1', sampleMeta(true));
    expect(cache.store.size).toBe(1);
    const back = await getPersistedMetadata('song-1');
    expect(back?.tags).toEqual(sampleMeta(true).tags);
    expect(back?.specs).toEqual(sampleMeta(true).specs);
    expect(Array.from(back!.picture!.data)).toEqual([1, 2, 3, 4]);
    expect(back?.picture?.mime).toBe('image/jpeg');
    expect(await getPersistedMetadata('missing')).toBeNull();
  });

  it('treats an entry whose cover art vanished as a miss', async () => {
    await persistMetadata('song-1', sampleMeta(true));
    cache.store.clear();
    expect(await getPersistedMetadata('song-1')).toBeNull();
  });

  it('works without the Cache API for art-less tracks and skips art-bearing ones', async () => {
    vi.stubGlobal('caches', undefined);
    await persistMetadata('plain', sampleMeta(false));
    await persistMetadata('with-art', sampleMeta(true));
    expect((await getPersistedMetadata('plain'))?.tags.title).toBe('T');
    expect(await getPersistedMetadata('with-art')).toBeNull();
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers();
    await persistMetadata('song-1', sampleMeta(false));
    vi.advanceTimersByTime(METADATA_CACHE_TTL_MS + 1000);
    expect(await getPersistedMetadata('song-1')).toBeNull();
    expect(JSON.parse(localStorage.getItem(METADATA_CACHE_KEY)!).entries['song-1']).toBeUndefined();
  });

  it('evicts the least recently used entries past the cap, including their art', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < METADATA_CACHE_MAX_ENTRIES + 2; i++) {
      vi.advanceTimersByTime(1000);
      await persistMetadata(`song-${i}`, sampleMeta(i < 2));
    }
    const entries = JSON.parse(localStorage.getItem(METADATA_CACHE_KEY)!).entries;
    expect(Object.keys(entries)).toHaveLength(METADATA_CACHE_MAX_ENTRIES);
    expect(entries['song-0']).toBeUndefined();
    expect(entries['song-1']).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(cache.store.size).toBe(0);
  });

  it('survives corrupt storage and clears everything', async () => {
    localStorage.setItem(METADATA_CACHE_KEY, '{nope');
    expect(await getPersistedMetadata('x')).toBeNull();
    await persistMetadata('song-1', sampleMeta(true));
    await clearMetadataCache();
    expect(localStorage.getItem(METADATA_CACHE_KEY)).toBeNull();
    expect(cache.store.size).toBe(0);
  });
});

// ─── Orchestration ──────────────────────────────────────────────────────────

describe('getTrackMetadata', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { installFakeCaches(); resetTrackMetadataMemory(); });
  afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllGlobals(); });

  it('dedupes concurrent loads, persists the result, and survives a "reload"', async () => {
    const { file } = buildBigTaggedFlac();
    const { fetchMock } = mockServer(file, { honorRange: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const source = { cacheKey: 'song-9', url: 'https://storage.example.com/big.flac' };

    const [a, b] = await Promise.all([getTrackMetadata(source), getTrackMetadata(source)]);
    expect(a).toBe(b);
    expect(a?.tags.title).toBe('Big Tagged');
    const callsAfterFirstLoad = fetchMock.mock.calls.length;

    await vi.waitFor(async () => expect(await getPersistedMetadata('song-9')).not.toBeNull());

    // New page load: memory is gone, persisted copy (incl. cover) must serve it with zero network.
    resetTrackMetadataMemory();
    const again = await getTrackMetadata(source);
    expect(again?.tags.album).toBe('Header Only');
    expect(again?.picture?.data.length).toBe(200 * 1024);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad);
  });

  it('parses local files directly and ignores stale files for remote URLs', async () => {
    const file = new File([fixture('test.flac') as BlobPart], 'test.flac', { type: 'audio/flac' });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const local = await getTrackMetadata({ cacheKey: 'local-1', url: 'blob:http://localhost/abc', file });
    expect(local?.tags.title).toBe('Fixture FLAC');
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(ownsFile('blob:http://localhost/abc', file)).toBe(true);
    expect(ownsFile('https://storage.example.com/x.flac', file)).toBe(false);
    expect(ownsFile('https://storage.example.com/x.flac', undefined)).toBe(false);

    // A stale currentFile must not leak its tags onto a remote track.
    const { file: remoteBytes } = buildBigTaggedFlac();
    globalThis.fetch = mockServer(remoteBytes, { honorRange: true }).fetchMock as unknown as typeof fetch;
    const remote = await getTrackMetadata({ cacheKey: 'remote-1', url: 'https://storage.example.com/big.flac', file: ownsFile('https://storage.example.com/big.flac', file) ? file : undefined });
    expect(remote?.tags.title).toBe('Big Tagged');
  });

  it('returns null for non-http(s) URLs without fetching', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await getTrackMetadata({ cacheKey: 'gs-1', url: 'gs://bucket/a.flac' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Keep the ByteSource type import honest for consumers writing custom sources.
const _typeCheck: ByteSource = { read: async () => new Uint8Array(0) };
void _typeCheck;
