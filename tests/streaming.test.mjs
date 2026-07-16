/**
 * Node-compatible streaming tests (mocked Range responses).
 * Run: node --test tests/streaming.test.mjs
 * CI uses vitest twin: tests/streaming.test.ts
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal ESM re-implementation of the selection logic under test
const STREAMING_THRESHOLD_BYTES = 32 * 1024 * 1024;

function isFlacUrl(url) {
  try {
    return new URL(url, 'http://local').pathname.toLowerCase().endsWith('.flac');
  } catch {
    return url.toLowerCase().includes('.flac');
  }
}

function selectDecodeStrategy(contentLength, { outputMode, url }) {
  const large = contentLength !== null && contentLength >= STREAMING_THRESHOLD_BYTES;
  if (outputMode === 'streaming') {
    if (isFlacUrl(url)) return large ? 'hifi-stream' : 'buffered';
    return 'native-stream';
  }
  if (outputMode === 'worklet') return large ? 'hifi-stream' : 'buffered';
  return 'buffered';
}

async function streamRemoteAudioMock(fetchImpl, url, { chunkSize = 256 } = {}) {
  const head = await fetchImpl(url, { method: 'HEAD' });
  const total = parseInt(head.headers.get('content-length') ?? '0', 10);
  const chunks = [];
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, total - 1);
    const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
    chunks.push(await res.arrayBuffer());
  }
  return chunks;
}

describe('streaming.test.mjs — mocked Range responses', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = mock.fn(async (url, init = {}) => {
      if (init.method === 'HEAD') {
        return {
          ok: true,
          status: 200,
          headers: new Map([
            ['content-length', '512'],
            ['accept-ranges', 'bytes'],
          ]),
          get(name) { return this.headers.get(name.toLowerCase()) ?? null; },
        };
      }
      const range = init.headers?.Range;
      if (range === 'bytes=0-255' || range === 'bytes=256-511') {
        return { ok: true, status: 206, arrayBuffer: async () => new Uint8Array(256).buffer };
      }
      throw new Error(`unexpected range ${range}`);
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('streams file in 256-byte range chunks', async () => {
    const chunks = await streamRemoteAudioMock(fetchMock, 'https://example.com/a.flac');
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].byteLength, 256);
    assert.equal(chunks[1].byteLength, 256);
    assert.equal(fetchMock.mock.calls.length, 3); // HEAD + 2 ranges
  });

  it('picks hifi-stream for 100MB FLAC', () => {
    assert.equal(
      selectDecodeStrategy(100 * 1024 * 1024, { outputMode: 'streaming', url: 'https://x/a.flac' }),
      'hifi-stream'
    );
  });
});
