import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeRemoteAudio,
  fetchByteRange,
  streamRemoteAudio,
} from '../src/utils/rangeFetch';
import {
  selectDecodeStrategy,
  isFlacUrl,
  STREAMING_THRESHOLD_BYTES,
  describePlaybackPath,
} from '../src/utils/playbackPath';

describe('rangeFetch', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('probeRemoteAudio reads Content-Length and Accept-Ranges', async () => {
    global.fetch = vi.fn(async () => new Response(null, {
      status: 200,
      headers: {
        'content-length': '104857600',
        'accept-ranges': 'bytes',
        'content-type': 'audio/flac',
      },
    })) as typeof fetch;

    const probe = await probeRemoteAudio('https://example.com/track.flac');
    expect(probe.contentLength).toBe(104857600);
    expect(probe.acceptsRanges).toBe(true);
    expect(probe.contentType).toBe('audio/flac');
  });

  it('fetchByteRange sends Range header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Range: 'bytes=0-255' });
      return new Response(new Uint8Array(256), { status: 206 });
    });
    global.fetch = fetchMock as typeof fetch;

    const buf = await fetchByteRange('https://example.com/a.flac', 0, 255);
    expect(buf.byteLength).toBe(256);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('streamRemoteAudio yields ranged chunks', async () => {
    const total = 512;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(total), 'accept-ranges': 'bytes' },
        });
      }
      const range = (init?.headers as Record<string, string>)?.Range;
      if (range === 'bytes=0-255') {
        return new Response(new Uint8Array(256), { status: 206 });
      }
      if (range === 'bytes=256-511') {
        return new Response(new Uint8Array(256), { status: 206 });
      }
      return new Response(null, { status: 416 });
    }) as typeof fetch;

    const chunks: number[] = [];
    let progressCalls = 0;
    for await (const chunk of streamRemoteAudio('https://example.com/large.flac', {
      chunkSize: 256,
      onProgress: () => { progressCalls += 1; },
    })) {
      chunks.push(chunk.byteLength);
    }

    expect(chunks).toEqual([256, 256]);
    expect(progressCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('playbackPath', () => {
  it('detects FLAC URLs', () => {
    expect(isFlacUrl('https://storage.example.com/music/song.flac')).toBe(true);
    expect(isFlacUrl('https://storage.example.com/music/song.wav')).toBe(false);
  });

  it('selects hifi-stream for large FLAC in streaming mode', () => {
    const strategy = selectDecodeStrategy(STREAMING_THRESHOLD_BYTES + 1, {
      outputMode: 'streaming',
      url: 'https://example.com/big.flac',
    });
    expect(strategy).toBe('hifi-stream');
    expect(describePlaybackPath(strategy).label).toBe('Hi-Fi streaming');
  });

  it('selects buffered for small FLAC in streaming mode', () => {
    const strategy = selectDecodeStrategy(1024 * 1024, {
      outputMode: 'streaming',
      url: 'https://example.com/small.flac',
    });
    expect(strategy).toBe('buffered');
  });

  it('selects native-stream for non-FLAC', () => {
    const strategy = selectDecodeStrategy(STREAMING_THRESHOLD_BYTES + 1, {
      outputMode: 'streaming',
      url: 'https://example.com/track.wav',
    });
    expect(strategy).toBe('native-stream');
  });

  it('auto-upgrades worklet mode to hifi-stream for large files', () => {
    const strategy = selectDecodeStrategy(100 * 1024 * 1024, {
      outputMode: 'worklet',
      url: 'https://example.com/huge.flac',
    });
    expect(strategy).toBe('hifi-stream');
  });
});
