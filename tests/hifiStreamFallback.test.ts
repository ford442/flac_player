// runHifiStreamPipeline: when the WASM decoder reports frame errors, streaming
// stops and the track finishes from a whole-file decodeAudioData, resuming at
// the first sample not yet delivered. Samples are index-coded (value = absolute
// frame index) so gaps and repeats are caught exactly.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamingChunk, StreamingDecoder } from '../src/utils/streamingDecoder';
import type { OpenedHifiTrack } from '../src/audio/hifiStreamPipeline';
import { createBlobReader } from '../src/utils/rangeFetch';

const native = vi.hoisted(() => ({ calls: 0, frames: 0, rate: 44100 }));

vi.mock('../src/audio/audioDecoder', async (importActual) => {
  const actual = await importActual<typeof import('../src/audio/audioDecoder')>();
  return {
    ...actual,
    decodeFlacNatively: vi.fn(async () => {
      native.calls++;
      const data = Float32Array.from({ length: native.frames }, (_, i) => i);
      return {
        numberOfChannels: 1,
        length: native.frames,
        sampleRate: native.rate,
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    }),
  };
});

const { runHifiStreamPipeline } = await import('../src/audio/hifiStreamPipeline');

/** Scripted decoder: chunk k of the input yields `script[k]`. */
function fakeDecoder(script: Array<{ from: number; frames: number; errors?: number }>): StreamingDecoder {
  let onChunk: ((c: StreamingChunk) => void | Promise<void>) | undefined;
  let onEnded: (() => void) | undefined;
  let k = 0;
  const emit = async (s: { from: number; frames: number; errors?: number }) => {
    const pcm = Float32Array.from({ length: s.frames }, (_, i) => s.from + i);
    await onChunk?.({
      interleavedBuffer: pcm,
      channels: s.errors ? 0 : 1,
      sampleRate: s.errors ? 0 : native.rate,
      duration: s.frames / native.rate,
      samplesDecoded: s.frames,
      errors: s.errors ?? 0,
    });
  };
  return {
    onChunkDecoded: (cb: typeof onChunk) => { onChunk = cb; },
    onError: () => {},
    onEnded: (cb: typeof onEnded) => { onEnded = cb; },
    appendChunk: vi.fn(async () => {
      const s = script[k++];
      if (s) await emit(s);
    }),
    flush: vi.fn(async () => { onEnded?.(); }),
    destroy: () => {},
  } as unknown as StreamingDecoder;
}

/** 4 MiB of input: 16 reader chunks at the default 256 KiB. */
function openedTrack(): OpenedHifiTrack {
  const reader = createBlobReader(new Blob([new Uint8Array(4 * 1024 * 1024)]));
  return { url: 'https://example.test/song.flac', reader, header: null, duration: null };
}

async function run(opened: OpenedHifiTrack, decoder: StreamingDecoder, startSeconds = 0) {
  const pushed: number[] = [];
  const meta: Array<{ channels: number; sampleRate: number }> = [];
  let ended = false;
  let error: Error | null = null;
  await runHifiStreamPipeline({
    url: opened.url,
    opened,
    startSeconds,
    decoder: Promise.resolve(decoder),
    onMetadata: (m) => { meta.push(m); },
    onPcmChunk: (pcm) => { pushed.push(...pcm); },
    onEnded: () => { ended = true; },
    onError: (e) => { error = e; },
  });
  return { pushed, meta, ended, error };
}

const isRange = (xs: number[], from: number, to: number) =>
  xs.length === to - from && xs.every((v, i) => v === from + i);

describe('hi-fi stream WASM → decodeAudioData fallback', () => {
  beforeEach(() => {
    native.calls = 0;
    native.frames = 100_000;
    native.rate = 44100;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('falls back from the first chunk when every frame errors (projectM files)', async () => {
    const decoder = fakeDecoder([{ from: 0, frames: 0, errors: 12 }]);
    const r = await run(openedTrack(), decoder);
    expect(r.error).toBeNull();
    expect(r.ended).toBe(true);
    expect(r.meta).toEqual([{ channels: 1, sampleRate: 44100 }]);
    expect(isRange(r.pushed, 0, native.frames)).toBe(true);
    // Stopped streaming after the first errored chunk instead of reading all 4.
    expect(decoder.appendChunk).toHaveBeenCalledTimes(1);
  });

  it('resumes at the first undelivered sample when errors start mid-stream', async () => {
    const decoder = fakeDecoder([
      { from: 0, frames: 4096 },
      { from: 4096, frames: 8192 },
      { from: 12288, frames: 2000, errors: 3 }, // partial PCM must be dropped
    ]);
    const r = await run(openedTrack(), decoder);
    expect(r.ended).toBe(true);
    expect(isRange(r.pushed, 0, native.frames)).toBe(true);
    expect(r.meta).toHaveLength(1);
  });

  it('honours the start offset (seek) on fallback', async () => {
    const opened = openedTrack();
    opened.wasmUnusable = true;
    const decoder = fakeDecoder([]);
    const r = await run(opened, decoder, 1);
    expect(decoder.appendChunk).not.toHaveBeenCalled();
    expect(isRange(r.pushed, 44100, native.frames)).toBe(true);
  });

  it('reuses the cached native decode across runs (seek after fallback)', async () => {
    const opened = openedTrack();
    await run(opened, fakeDecoder([{ from: 0, frames: 0, errors: 1 }]));
    expect(opened.wasmUnusable).toBe(true);
    const second = fakeDecoder([]);
    const r = await run(opened, second, 2);
    expect(second.appendChunk).not.toHaveBeenCalled();
    expect(native.calls).toBe(1);
    expect(isRange(r.pushed, 88200, native.frames)).toBe(true);
  });

  it('streams normally (no native decode) when WASM reports no errors', async () => {
    const decoder = fakeDecoder([
      { from: 0, frames: 4096 },
      { from: 4096, frames: 4096 },
      { from: 8192, frames: 4096 },
      { from: 12288, frames: 4096 },
    ]);
    const r = await run(openedTrack(), decoder);
    expect(native.calls).toBe(0);
    expect(r.ended).toBe(true);
    expect(isRange(r.pushed, 0, 16384)).toBe(true);
  });
});
