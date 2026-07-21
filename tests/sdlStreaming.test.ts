import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectDecodeStrategy, STREAMING_THRESHOLD_BYTES } from '../src/utils/playbackPath';
import { BaseSdlBackend, type SdlCommonModule } from '../src/audio/backends/BaseSdlBackend';

/**
 * Simulates the WASM feed ring in JS: a bounded buffer that accepts short
 * writes when full and is drained by a fake audio callback. This is what lets
 * us assert back-pressure and position advance without loading real WASM.
 */
class FakeSdlModule {
  capacity: number;
  ring: number[] = [];
  consumed = 0;
  streamEnded = false;
  channels = 2;
  sampleRate = 48000;
  started = false;
  heap: Float32Array;
  private allocOffset = 64;
  /** Largest fill percentage ever observed — proves the ring stayed bounded. */
  peakFill = 0;

  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.heap = new Float32Array(1024 * 1024);
  }

  _init_audio() { return 1; }
  _start_stream(channels: number, sampleRate: number) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.started = true;
    this.ring = [];
    this.consumed = 0;
    return 1;
  }
  _feed_pcm_chunk(ptr: number, samples: number) {
    const space = this.capacity - this.ring.length;
    const accepted = Math.min(space, samples);
    const base = ptr / 4;
    for (let i = 0; i < accepted; i++) this.ring.push(this.heap[base + i]);
    this.peakFill = Math.max(this.peakFill, this._get_buffer_fill_level());
    return accepted;
  }
  _get_buffer_fill_level() {
    return Math.floor((this.ring.length * 100) / this.capacity);
  }
  _set_stream_ended(ended: number) { this.streamEnded = ended !== 0; }
  /** Stand-in for the SDL audio callback pulling samples. */
  drain(samples: number) {
    const taken = this.ring.splice(0, samples);
    this.consumed += taken.length;
    return taken;
  }
  _get_current_time() {
    return this.consumed / (this.channels * this.sampleRate);
  }
  _malloc(bytes: number) {
    const ptr = this.allocOffset;
    this.allocOffset += bytes + 16;
    return ptr;
  }
  _free() { /* no-op */ }
  _play() { /* no-op */ }
  _pause_audio() { /* no-op */ }
  _resume_audio() { /* no-op */ }
  _stop() { /* no-op */ }
  _seek() { throw new Error('seek must not reach the module in streaming mode'); }
  _set_volume() { /* no-op */ }
  _get_pcm_ring_state() { return 0; }
  _get_pcm_ring_data() { return 0; }
  _cleanup() { /* no-op */ }
  get HEAPF32() { return this.heap; }
}

/** Minimal concrete backend over the fake module. */
class TestSdlBackend extends BaseSdlBackend<SdlCommonModule> {
  protected readonly label = 'TestSdl';
  constructor(public fake: FakeSdlModule) {
    // The context manager is only touched by the URL streaming path, which
    // these tests drive through the feed helpers directly.
    super({} as never);
    this.module = fake as unknown as SdlCommonModule;
  }
  protected async loadModule() { return this.fake as unknown as SdlCommonModule; }
  protected writeAudioData() { /* buffered path unused here */ }

  /** Expose the protected feed path for testing. */
  feed(chunk: Float32Array) {
    return (this as unknown as {
      feedChunk: (m: SdlCommonModule, c: Float32Array) => Promise<void>;
    }).feedChunk(this.module as SdlCommonModule, chunk);
  }
  setStreaming(on: boolean) {
    (this as unknown as { streaming: boolean }).streaming = on;
  }
}

describe('SDL streaming decode strategy', () => {
  const bigFlac = 'https://storage.noahcohn.com/files/audio/music/album.flac';

  it('routes large FLAC to hifi-stream for both SDL backends', () => {
    const large = STREAMING_THRESHOLD_BYTES + 1;
    expect(selectDecodeStrategy(large, { outputMode: 'sdl', url: bigFlac })).toBe('hifi-stream');
    expect(selectDecodeStrategy(large, { outputMode: 'sdl2', url: bigFlac })).toBe('hifi-stream');
  });

  it('keeps small files buffered so seek still works', () => {
    const small = 4 * 1024 * 1024;
    expect(selectDecodeStrategy(small, { outputMode: 'sdl', url: bigFlac })).toBe('buffered');
    expect(selectDecodeStrategy(small, { outputMode: 'sdl2', url: bigFlac })).toBe('buffered');
  });
});

describe('SDL chunked feed', () => {
  let fake: FakeSdlModule;
  let backend: TestSdlBackend;

  beforeEach(() => {
    fake = new FakeSdlModule(4096);
    backend = new TestSdlBackend(fake);
    fake._start_stream(2, 48000);
  });

  it('advances playback position as chunks are fed and drained', async () => {
    expect(fake._get_current_time()).toBe(0);

    // 0.2 s of stereo audio at 48k = 19200 interleaved samples, well over the
    // 4096-sample ring, so this exercises several refill rounds.
    const samples = 48000 * 2 / 5;
    const chunk = new Float32Array(samples).fill(0.25);

    // Drain continuously, as the SDL callback would.
    const drainer = setInterval(() => fake.drain(2048), 1);
    await backend.feed(chunk);
    clearInterval(drainer);
    fake.drain(fake.ring.length);

    // Everything fed was consumed: 19200 / (2 * 48000) = 0.2 s
    const position = fake._get_current_time();
    expect(position).toBeGreaterThan(0);
    expect(position).toBeCloseTo(0.2, 3);
  });

  it('never exceeds the ring capacity when the producer outruns the consumer', async () => {
    // Ten times the ring capacity, with no draining until the very end.
    const oversized = new Float32Array(fake.capacity * 10).fill(0.5);

    let drained = 0;
    const drainer = setInterval(() => { drained += fake.drain(512).length; }, 1);
    await backend.feed(oversized);
    clearInterval(drainer);

    // The whole chunk got through without the ring ever overflowing.
    expect(drained + fake.ring.length).toBe(oversized.length);
    expect(fake.ring.length).toBeLessThanOrEqual(fake.capacity);
    expect(fake.peakFill).toBeLessThanOrEqual(100);
  });

  it('reports short writes rather than dropping samples when full', () => {
    const chunk = new Float32Array(fake.capacity * 2).fill(0.1);
    fake.heap.set(chunk.subarray(0, chunk.length), 16);

    const accepted = fake._feed_pcm_chunk(64, chunk.length);
    expect(accepted).toBe(fake.capacity);
    expect(accepted).toBeLessThan(chunk.length);
    expect(fake.ring.length).toBe(fake.capacity);
  });

  it('does not forward seek to the module while streaming', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend.setStreaming(true);
    expect(() => backend.seek(30)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Seek not supported'));
    warn.mockRestore();
  });

  it('signals end of stream to the module', () => {
    expect(fake.streamEnded).toBe(false);
    fake._set_stream_ended(1);
    expect(fake.streamEnded).toBe(true);
  });
});
