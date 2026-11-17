import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_RING_CHANNELS,
  ANALYSIS_RING_GENERATION,
  ANALYSIS_RING_HEADER_BYTES,
  ANALYSIS_RING_SAMPLE_RATE,
  ANALYSIS_RING_WRITE_POS,
  createAnalysisRingBuffer,
  readerForRingBuffer,
  type AnalysisRingReader,
} from '../src/audio/analysisRing';
import { instantiateDspAnalysis } from '../src/audio/dspAnalysisInstance';
import { LoudnessMeter, STALE_MS, type LoudnessReading } from '../src/audio/loudnessMeter';

// The meter reads the analysis ring on the main thread and runs dsp_loudness.h
// from public/dsp-chain.wasm; the writer here stands in for dspChainProcessor.js.

const RATE = 48000;
const wasmModule = new WebAssembly.Module(readFileSync(path.resolve(__dirname, '../public/dsp-chain.wasm')));

class RingWriter {
  readonly header: Uint32Array;
  readonly data: Float32Array;
  private t = 0;

  constructor(readonly buffer: SharedArrayBuffer, channels = 2, sampleRate = RATE) {
    this.header = new Uint32Array(buffer, 0, 8);
    const capacity = this.header[2];
    this.data = new Float32Array(buffer, ANALYSIS_RING_HEADER_BYTES, capacity);
    Atomics.store(this.header, ANALYSIS_RING_CHANNELS, channels);
    Atomics.store(this.header, ANALYSIS_RING_SAMPLE_RATE, sampleRate);
  }

  /** Append `seconds` of a stereo 1 kHz sine at `dbfs` peak, like the processor's writeRing. */
  sine(seconds: number, dbfs: number): void {
    const amplitude = 10 ** (dbfs / 20);
    const frames = Math.round(seconds * RATE);
    const mask = this.data.length - 1;
    let wp = Atomics.load(this.header, ANALYSIS_RING_WRITE_POS);
    for (let i = 0; i < frames; i++, this.t++) {
      const v = amplitude * Math.sin((2 * Math.PI * 1000 * this.t) / RATE);
      this.data[wp++ & mask] = v;
      this.data[wp++ & mask] = v;
      if ((i & 1023) === 1023) Atomics.store(this.header, ANALYSIS_RING_WRITE_POS, wp >>> 0);
    }
    Atomics.store(this.header, ANALYSIS_RING_WRITE_POS, wp >>> 0);
  }

  reset(): void {
    Atomics.store(this.header, ANALYSIS_RING_WRITE_POS, 0);
    Atomics.add(this.header, ANALYSIS_RING_GENERATION, 1);
  }
}

function setup(options: { reader?: AnalysisRingReader | null; loadFails?: boolean } = {}) {
  vi.stubGlobal('crossOriginIsolated', true);
  const ring = createAnalysisRingBuffer()!;
  const writer = new RingWriter(ring);
  let reader: AnalysisRingReader | null = options.reader === undefined ? readerForRingBuffer(ring) : options.reader;
  let now = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const meter = new LoudnessMeter({
    loadInstance: async () => {
      if (options.loadFails) throw new Error('no module');
      return instantiateDspAnalysis(wasmModule);
    },
    getReader: () => reader,
    now: () => now,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (id) => { cleared.push(id); },
  });
  const readings: Array<LoudnessReading | null> = [];
  return {
    meter,
    writer,
    readings,
    timers,
    cleared,
    advance: (ms: number) => { now += ms; },
    setReader: (next: AnalysisRingReader | null) => { reader = next; },
    /** Wait for the wasm instance to load. */
    ready: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

describe('LoudnessMeter (analysis ring → dsp_loudness.h, off the audio thread)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads momentary after 400 ms and short-term after 3 s of a -23 dBFS sine (Tech 3341)', async () => {
    const t = setup();
    t.meter.subscribe((r) => t.readings.push(r));
    await t.ready();

    t.writer.sine(0.3, -23);
    t.meter.poll();
    expect(t.meter.latest()).toMatchObject({ momentary: null, shortTerm: null, live: true, channels: 2, sampleRate: RATE });

    for (let i = 0; i < 6; i++) {
      t.writer.sine(0.5, -23);
      t.meter.poll();
    }
    const reading = t.meter.latest()!;
    expect(reading.momentary).toBeCloseTo(-23, 1);
    expect(reading.shortTerm).toBeCloseTo(-23, 1);
    expect(t.readings.at(-1)).toBe(reading);
  });

  it('polls every 100 ms for stereo 48 kHz', async () => {
    const t = setup();
    t.meter.subscribe(() => {});
    await t.ready();
    t.writer.sine(0.1, -23);
    t.meter.poll();
    expect(t.timers.at(-1)!.ms).toBe(100);
  });

  it('restarts the windows when the writer laps the cursor (a throttled tab)', async () => {
    const t = setup();
    t.meter.subscribe(() => {});
    await t.ready();
    t.writer.sine(1, -23);
    t.meter.poll();
    expect(t.meter.latest()!.momentary).toBeCloseTo(-23, 1);

    // 2 s between polls: more than the ring holds, so frames were lost.
    t.writer.sine(2, -10);
    t.meter.poll();
    // The read after the gap is the ring's last ~1.28 s: momentary refills, short-term does not.
    expect(t.meter.latest()!.momentary).toBeCloseTo(-10, 1);
    expect(t.meter.latest()!.shortTerm).toBeNull();
  });

  it('restarts the windows on a ring reset (seek / stop)', async () => {
    const t = setup();
    t.meter.subscribe(() => {});
    await t.ready();
    t.writer.sine(1, -23);
    t.meter.poll();
    t.writer.reset();
    t.writer.sine(0.2, -23);
    t.meter.poll();
    expect(t.meter.latest()!.momentary).toBeNull();
  });

  it('marks the reading not live once frames stop arriving (pause, suspended context)', async () => {
    const t = setup();
    t.meter.subscribe(() => {});
    await t.ready();
    t.writer.sine(1, -23);
    t.meter.poll();
    t.advance(STALE_MS - 1);
    t.meter.poll();
    expect(t.meter.latest()!.live).toBe(true);
    t.advance(2);
    t.meter.poll();
    expect(t.meter.latest()!.live).toBe(false);
    expect(t.meter.latest()!.momentary).toBeCloseTo(-23, 1);
  });

  it('starts from a new ring when the graph is rebuilt', async () => {
    const t = setup();
    t.meter.subscribe(() => {});
    await t.ready();
    t.writer.sine(1, -23);
    t.meter.poll();
    const other = setup();
    other.writer.sine(0.5, -30);
    t.setReader(readerForRingBuffer(other.writer.buffer));
    t.meter.poll();
    expect(t.meter.latest()!.momentary).toBeCloseTo(-30, 1);
  });

  it('stays null without a ring or without the module, and never throws', async () => {
    const noRing = setup({ reader: null });
    noRing.meter.subscribe(() => {});
    await noRing.ready();
    expect(() => noRing.meter.poll()).not.toThrow();
    expect(noRing.meter.latest()).toBeNull();

    const noModule = setup({ loadFails: true });
    noModule.meter.subscribe(() => {});
    await noModule.ready();
    noModule.writer.sine(1, -23);
    expect(() => noModule.meter.poll()).not.toThrow();
    expect(noModule.meter.latest()).toBeNull();
  });

  it('runs only while subscribed', async () => {
    const t = setup();
    const off = t.meter.subscribe(() => {});
    const offToo = t.meter.subscribe(() => {});
    expect(t.timers).toHaveLength(1);
    await t.ready();
    t.writer.sine(1, -23);
    t.meter.poll();
    off();
    expect(t.cleared).toHaveLength(0);
    offToo();
    expect(t.cleared).toHaveLength(1);
    expect(t.meter.latest()).toBeNull();
  });
});
