/**
 * Sample-rate conversion for the worklet backend when the AudioContext cannot
 * open the file's native rate (see sampleRatePolicy.ts / chooseContextSampleRate).
 *
 *   SpeexDSP WASM (public/speex-resampler.*, quality 10)  — default
 *   LinearStreamResampler (linearResampler.ts)            — if the module fails to load
 *
 * Streams are stateful: chunk boundaries of the hi-fi pipeline are seamless.
 * Callers skip this entirely when file rate === context rate.
 */
import { LinearStreamResampler, resampleInterleavedLinear } from './linearResampler';
import { WASM_ASSETS, loadWasmScript } from './wasmLoader';

export interface SpeexResamplerModule {
  _rs_create(channels: number, inRate: number, outRate: number, quality: number): number;
  _rs_process(state: number, inPtr: number, inFrames: number, outPtr: number, outCapacityFrames: number): number;
  _rs_last_consumed(): number;
  _rs_input_latency(state: number): number;
  _rs_reset(state: number): void;
  _rs_destroy(state: number): void;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

export type SpeexResamplerFactory = () => Promise<SpeexResamplerModule>;

declare global {
  interface Window {
    createSpeexResamplerModule?: SpeexResamplerFactory;
  }
}

/** SPEEX_RESAMPLER_QUALITY_MAX. */
export const SPEEX_QUALITY = 10;

export type ResamplerKind = 'speex' | 'linear';

export interface StreamResampler {
  readonly kind: ResamplerKind;
  /** Interleaved in → interleaved out (may be shorter than `ratio × in` until flushed). */
  process(input: Float32Array): Float32Array;
  /** Drain the filter tail at end of stream. */
  flush(): Float32Array;
  /** Forget history (seek). */
  reset(): void;
  destroy(): void;
}

let speexModule: Promise<SpeexResamplerModule | null> | null = null;

async function defaultFactory(): Promise<SpeexResamplerModule> {
  if (!window.createSpeexResamplerModule) await loadWasmScript(WASM_ASSETS.speexResampler);
  if (!window.createSpeexResamplerModule) throw new Error('createSpeexResamplerModule missing');
  return window.createSpeexResamplerModule();
}

/** Load (once) the SpeexDSP module; resolves null when it cannot load. */
export function loadSpeexResampler(factory: SpeexResamplerFactory = defaultFactory): Promise<SpeexResamplerModule | null> {
  if (!speexModule) {
    speexModule = factory().catch((err) => {
      console.warn('[resampler] SpeexDSP WASM unavailable; using linear interpolation:', err);
      return null;
    });
  }
  return speexModule;
}

/** Test hook: forget the cached module. */
export function resetSpeexResamplerForTests(): void {
  speexModule = null;
}

class SpeexStreamResampler implements StreamResampler {
  readonly kind = 'speex' as const;
  private inPtr = 0;
  private inCap = 0;
  private outPtr = 0;
  private outCap = 0;
  private framesIn = 0;
  private framesOut = 0;

  constructor(
    private readonly m: SpeexResamplerModule,
    private readonly state: number,
    private readonly channels: number,
    private readonly fromRate: number,
    private readonly toRate: number
  ) {}

  private reserve(inFrames: number, outFrames: number): void {
    const ch = this.channels;
    if (inFrames > this.inCap) {
      if (this.inPtr) this.m._free(this.inPtr);
      this.inCap = inFrames;
      this.inPtr = this.m._malloc(inFrames * ch * 4);
    }
    if (outFrames > this.outCap) {
      if (this.outPtr) this.m._free(this.outPtr);
      this.outCap = outFrames;
      this.outPtr = this.m._malloc(outFrames * ch * 4);
    }
    if (!this.inPtr || !this.outPtr) throw new Error('SpeexDSP resampler out of memory');
  }

  private run(input: Float32Array): Float32Array {
    const ch = this.channels;
    const frames = Math.floor(input.length / ch);
    if (frames === 0) return new Float32Array(0);
    const outGuess = Math.ceil((frames * this.toRate) / this.fromRate) + 16;
    this.reserve(frames, outGuess);
    // HEAPF32 is re-read after every call: memory growth replaces the view.
    this.m.HEAPF32.set(input.subarray(0, frames * ch), this.inPtr >> 2);
    const out = new Float32Array(outGuess * ch);
    let consumed = 0;
    let produced = 0;
    while (consumed < frames) {
      const room = outGuess - produced;
      if (room <= 0) break;
      const n = this.m._rs_process(
        this.state,
        this.inPtr + consumed * ch * 4,
        frames - consumed,
        this.outPtr,
        room
      );
      if (n < 0) throw new Error('SpeexDSP resampler failed');
      const used = this.m._rs_last_consumed();
      out.set(this.m.HEAPF32.subarray(this.outPtr >> 2, (this.outPtr >> 2) + n * ch), produced * ch);
      produced += n;
      consumed += used;
      if (n === 0 && used === 0) break;
    }
    return out.subarray(0, produced * ch);
  }

  process(input: Float32Array): Float32Array {
    const out = this.run(input);
    this.framesIn += Math.floor(input.length / this.channels);
    this.framesOut += out.length / this.channels;
    return out;
  }

  flush(): Float32Array {
    const expected = Math.round((this.framesIn * this.toRate) / this.fromRate);
    const missing = expected - this.framesOut;
    if (missing <= 0) return new Float32Array(0);
    const latency = this.m._rs_input_latency(this.state) + 1;
    const tail = this.run(new Float32Array(latency * this.channels));
    const keep = Math.min(tail.length, missing * this.channels);
    this.framesOut += keep / this.channels;
    return tail.subarray(0, keep);
  }

  reset(): void {
    this.m._rs_reset(this.state);
    this.framesIn = 0;
    this.framesOut = 0;
  }

  destroy(): void {
    this.m._rs_destroy(this.state);
    if (this.inPtr) this.m._free(this.inPtr);
    if (this.outPtr) this.m._free(this.outPtr);
    this.inPtr = this.outPtr = 0;
    this.inCap = this.outCap = 0;
  }
}

class LinearFallback implements StreamResampler {
  readonly kind = 'linear' as const;
  private readonly inner: LinearStreamResampler;
  constructor(channels: number, fromRate: number, toRate: number) {
    this.inner = new LinearStreamResampler(channels, fromRate, toRate);
  }
  process(input: Float32Array): Float32Array { return this.inner.process(input); }
  flush(): Float32Array { return this.inner.flush(); }
  reset(): void { this.inner.reset(); }
  destroy(): void { /* nothing held */ }
}

export async function createStreamResampler(
  channels: number,
  fromRate: number,
  toRate: number,
  options: { factory?: SpeexResamplerFactory; forceLinear?: boolean } = {}
): Promise<StreamResampler> {
  if (!options.forceLinear) {
    const m = await loadSpeexResampler(options.factory);
    const state = m ? m._rs_create(channels, fromRate, toRate, SPEEX_QUALITY) : 0;
    if (m && state) return new SpeexStreamResampler(m, state, channels, fromRate, toRate);
  }
  return new LinearFallback(channels, fromRate, toRate);
}

/** One-shot conversion of a whole decoded buffer (buffered worklet path). */
export async function resampleInterleaved(
  input: Float32Array,
  channels: number,
  fromRate: number,
  toRate: number,
  options: { factory?: SpeexResamplerFactory; forceLinear?: boolean } = {}
): Promise<Float32Array> {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return input;
  const rs = await createStreamResampler(channels, fromRate, toRate, options);
  if (rs.kind === 'linear') {
    rs.destroy();
    return resampleInterleavedLinear(input, channels, fromRate, toRate);
  }
  try {
    const body = rs.process(input);
    const tail = rs.flush();
    const out = new Float32Array(body.length + tail.length);
    out.set(body);
    out.set(tail, body.length);
    return out;
  } finally {
    rs.destroy();
  }
}
