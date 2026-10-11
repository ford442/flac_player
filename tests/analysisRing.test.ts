import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_RING_GENERATION,
  ANALYSIS_RING_HEADER_BYTES,
  ANALYSIS_RING_WRITE_POS,
  AnalysisRingReader,
  createAnalysisRingBuffer,
  getAnalysisTap,
  readerForRingBuffer,
  setAnalysisTap,
} from '../src/audio/analysisRing';
import type { DspChainOptions } from '../src/audio/worklets/dspChainMessages';

// The analysis ring's JS writer lives inline in dspChainProcessor.js (a static
// worklet module). Load that file into a minimal AudioWorkletGlobalScope and
// read what it writes back through AnalysisRingReader — the same reader that
// consumes SDL's analysis_ring.h out of the SDL module's shared memory.

const RATE = 48000;
const wasmBytes = readFileSync(path.resolve(__dirname, '../public/dsp-chain.wasm'));

interface ProcessorInstance {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new (options: { processorOptions: DspChainOptions }) => ProcessorInstance;

let DspChainProcessor: ProcessorCtor;

beforeAll(async () => {
  class FakeProcessor {
    port = { onmessage: null, postMessage: () => {} };
  }
  vi.stubGlobal('AudioWorkletProcessor', FakeProcessor);
  vi.stubGlobal('sampleRate', RATE);
  vi.stubGlobal('registerProcessor', (_name: string, ctor: ProcessorCtor) => {
    DspChainProcessor = ctor;
  });
  await import('../src/audio/worklets/dspChainProcessor.js');
});

afterEach(() => {
  setAnalysisTap('sdl', null);
  setAnalysisTap('dsp-chain', null);
});

function ringBuffer(capacity?: number): SharedArrayBuffer {
  vi.stubGlobal('crossOriginIsolated', true);
  const buffer = createAnalysisRingBuffer(capacity);
  expect(buffer).not.toBeNull();
  return buffer!;
}

function processor(ring: SharedArrayBuffer | null, channels = 2): ProcessorInstance {
  return new DspChainProcessor({
    processorOptions: {
      wasm: new WebAssembly.Module(wasmBytes),
      channels,
      initial: { eqBands: [], replayGain: 1, limiter: false, volume: 0.5 },
      analysisRing: ring,
    },
  });
}

/** Run one quantum of planar input; returns the processor output, interleaved. */
function quantum(p: ProcessorInstance, start: number, frames = 128, channels = 2): Float32Array {
  const input = Array.from({ length: channels }, (_, ch) => {
    const block = new Float32Array(frames);
    for (let i = 0; i < frames; i++) block[i] = Math.sin((start + i) * 0.01 + ch);
    return block;
  });
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  p.process([input], [output]);
  const interleaved = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) interleaved[i * channels + ch] = output[ch][i];
  }
  return interleaved;
}

describe('analysis ring (dsp-chain worklet writer → AnalysisRingReader)', () => {
  it('carries exactly what the processor output, newest frames last', () => {
    const ring = ringBuffer();
    const p = processor(ring);
    const reader = readerForRingBuffer(ring);
    const out = [quantum(p, 0), quantum(p, 128), quantum(p, 256)];

    expect(reader.channels).toBe(2);
    expect(reader.sampleRate).toBe(RATE);
    const snap = reader.readLatest(200)!;
    expect(snap.frames).toBe(200);
    const expected = new Float32Array(384 * 2);
    out.forEach((block, i) => expected.set(block, i * 256));
    expect(snap.pcm).toEqual(expected.subarray(expected.length - 400));
    // Volume 0.5 ran before the copy: the ring holds post-DSP PCM.
    expect(snap.pcm[snap.pcm.length - 2]).toBeCloseTo(0.5 * Math.sin(383 * 0.01), 6);
  });

  it('returns fewer frames right after a reset, then none once reset again', () => {
    const ring = ringBuffer();
    const p = processor(ring);
    const reader = readerForRingBuffer(ring);
    expect(reader.readLatest(2048)).toBeNull();
    quantum(p, 0);
    expect(reader.readLatest(2048)!.frames).toBe(128);

    const generation = reader.generation;
    p.port.onmessage!({ data: { type: 'reset' } });
    expect(reader.generation).toBe(generation + 1);
    expect(reader.readLatest(2048)).toBeNull();
  });

  it('wraps around a small ring and keeps the newest window', () => {
    const ring = ringBuffer(1024);
    const p = processor(ring);
    const reader = readerForRingBuffer(ring);
    let last = new Float32Array(0);
    for (let q = 0; q < 11; q++) last = quantum(p, q * 128); // 2816 floats through 1024
    const snap = reader.readLatest(10_000)!;
    // Capped at (capacity − writer margin) / channels: margin = capacity / 2 here.
    expect(snap.frames).toBe(256);
    expect(snap.pcm.subarray(snap.pcm.length - last.length)).toEqual(last);
  });

  it('retries a copy the writer lapped, and gives up rather than return torn PCM', () => {
    const ring = ringBuffer(1024);
    const p = processor(ring);
    const reader = readerForRingBuffer(ring);
    for (let q = 0; q < 4; q++) quantum(p, q * 128);

    // Simulate the writer advancing a full ring between the copy and the re-check.
    const realLoad = Atomics.load;
    let checks = 0;
    const spy = vi.spyOn(Atomics, 'load').mockImplementation(((ta: Uint32Array, index: number) => {
      const value = realLoad(ta, index);
      if (ta.buffer === ring && index === ANALYSIS_RING_WRITE_POS && ++checks === 2) return value + 1024;
      return value;
    }) as typeof Atomics.load);
    const snap = reader.readLatest(256);
    spy.mockRestore();
    expect(checks).toBe(4); // torn first attempt, clean second
    expect(snap?.frames).toBe(256);

    const always = vi.spyOn(Atomics, 'load').mockImplementation(((ta: Uint32Array, index: number) => (
      ta.buffer === ring && index === ANALYSIS_RING_GENERATION ? realLoad(ta, index) + (checks++ % 2) : realLoad(ta, index)
    )) as typeof Atomics.load);
    expect(reader.readLatest(256)).toBeNull();
    always.mockRestore();
  });

  it('only hands out whole frames when writePos is mid-frame', () => {
    const ring = ringBuffer(1024);
    const reader = readerForRingBuffer(ring);
    const header = new Uint32Array(ring, 0, 8);
    const data = new Float32Array(ring, ANALYSIS_RING_HEADER_BYTES, 1024);
    for (let i = 0; i < 7; i++) data[i] = i;
    header[3] = 2; // channels
    header[ANALYSIS_RING_WRITE_POS] = 7;
    const snap = reader.readLatest(16)!;
    expect(snap.frames).toBe(3);
    expect(Array.from(snap.pcm)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('is not written when the page cannot share memory', () => {
    vi.stubGlobal('crossOriginIsolated', false);
    expect(createAnalysisRingBuffer()).toBeNull();
    const p = processor(null);
    expect(() => quantum(p, 0)).not.toThrow();
  });

  it('prefers the SDL tap while SDL owns output', () => {
    const dsp = readerForRingBuffer(ringBuffer(1024));
    const sdl = new AnalysisRingReader(ringBuffer(1024), 0, ANALYSIS_RING_HEADER_BYTES);
    expect(getAnalysisTap()).toBeNull();
    setAnalysisTap('dsp-chain', dsp);
    expect(getAnalysisTap()).toEqual({ source: 'dsp-chain', reader: dsp });
    setAnalysisTap('sdl', sdl);
    expect(getAnalysisTap()).toEqual({ source: 'sdl', reader: sdl });
    setAnalysisTap('sdl', null);
    expect(getAnalysisTap()?.source).toBe('dsp-chain');
  });
});
