import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EQ_BANDS } from '../src/audio/EQChain';
import { DSP_EQ_TYPE_CODES } from '../src/audio/worklets/dspChainMessages';

// Golden checks for public/dsp-chain.wasm (src/sdl/dsp_chain.h via
// src/dsp/dsp_wasm_entry.cpp), instantiated exactly like dspChainProcessor.js:
// empty import object, _initialize(), fixed scratch view.

interface DspExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  scratch_ptr(): number;
  scratch_floats(): number;
  set_eq_band(index: number, type: number, freq: number, q: number, gainDb: number): void;
  set_replaygain(linear: number, limiterEnabled: number): void;
  request_reset(): void;
  process(numFloats: number, channels: number, sampleRate: number, volume: number): void;
  set_playback_rate(rate: number, preservePitch: number): void;
  configure_stretch(channels: number, sampleRate: number): number;
  stretch_engaged(): number;
  loudness_reset(channels: number, sampleRate: number): void;
  loudness_push(numFloats: number): void;
  loudness_momentary(): number;
  loudness_short_term(): number;
}

const wasmBytes = readFileSync(path.resolve(__dirname, '../public/dsp-chain.wasm'));
const RATE = 48000;
const TOLERANCE_DB = 0.01;

function instantiate(): { dsp: DspExports; scratch: Float32Array } {
  const module = new WebAssembly.Module(wasmBytes);
  const dsp = new WebAssembly.Instance(module, {}).exports as unknown as DspExports;
  dsp._initialize?.();
  return { dsp, scratch: new Float32Array(dsp.memory.buffer, dsp.scratch_ptr(), dsp.scratch_floats()) };
}

function setGains(dsp: DspExports, gains: number[]): void {
  DEFAULT_EQ_BANDS.forEach((band, i) => {
    dsp.set_eq_band(i, DSP_EQ_TYPE_CODES[band.type] ?? 1, band.frequency, band.Q, gains[i] ?? 0);
  });
}

/** Interleaved stereo sine, both channels identical. */
function stereoSine(freq: number, seconds: number, amplitude: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE);
    out[2 * i] = v;
    out[2 * i + 1] = v;
  }
  return out;
}

/** Run interleaved PCM through the module in worklet-sized blocks. */
function run(
  { dsp, scratch }: { dsp: DspExports; scratch: Float32Array },
  input: Float32Array,
  { channels = 2, volume = 1, blockFrames = 128 } = {}
): Float32Array {
  const out = new Float32Array(input.length);
  const block = blockFrames * channels;
  for (let start = 0; start < input.length; start += block) {
    const n = Math.min(block, input.length - start);
    scratch.set(input.subarray(start, start + n));
    dsp.process(n, channels, RATE, volume);
    out.set(scratch.subarray(0, n), start);
  }
  return out;
}

function rmsDb(samples: Float32Array, from: number): number {
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += samples[i] * samples[i];
  return 10 * Math.log10(sum / (samples.length - from));
}

/** |H(f)| in dB for the Web Audio BiquadFilterNode formulas (shelves: S = 1, Q ignored). */
function biquadMagnitudeDb(type: BiquadFilterType, f0: number, q: number, gainDb: number, f: number): number {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / RATE;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  let b: number[];
  let a: number[];
  if (type === 'peaking') {
    const alpha = sw / (2 * q);
    b = [1 + alpha * A, -2 * cw, 1 - alpha * A];
    a = [1 + alpha / A, -2 * cw, 1 - alpha / A];
  } else {
    const k = 2 * Math.sqrt(A) * (sw / 2) * Math.SQRT2;
    if (type === 'lowshelf') {
      b = [A * ((A + 1) - (A - 1) * cw + k), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - k)];
      a = [(A + 1) + (A - 1) * cw + k, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - k];
    } else {
      b = [A * ((A + 1) + (A - 1) * cw + k), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - k)];
      a = [(A + 1) - (A - 1) * cw + k, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - k];
    }
  }
  const w = (2 * Math.PI * f) / RATE;
  const mag = (c: number[]) => Math.hypot(
    c[0] + c[1] * Math.cos(-w) + c[2] * Math.cos(-2 * w),
    c[1] * Math.sin(-w) + c[2] * Math.sin(-2 * w)
  );
  return 20 * Math.log10(mag(b) / mag(a));
}

/** FNV-1a over the little-endian bytes of each float (matches tests/native/dsp_simd_golden.cpp). */
function fnv1a(samples: Float32Array): number {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// `npm run test:dsp-golden` prints these for the SDL build of dsp_chain.h.
const NATIVE_GOLDEN_FNV1A = { limiterOff: 0xd443445c, limiterOn: 0x70844a79 };
// ...and these from tests/native/dsp_stretch_golden.cpp (pitch hold).
const STRETCH_GOLDEN_FNV1A = { unityHold: 0x811867b3, held125: 0x815f2789 };

/** dsp_stretch_golden.cpp fresh_chain(): flat EQ, unity gain, stretcher sized for stereo 48 kHz. */
function freshStretchChain(rate: number, hold: boolean): { dsp: DspExports; scratch: Float32Array } {
  const inst = instantiate();
  for (let b = 0; b < 8; b++) inst.dsp.set_eq_band(b, 1, 1000, 1, 0);
  inst.dsp.set_replaygain(1, 0);
  expect(inst.dsp.configure_stretch(2, RATE)).toBe(7200);
  inst.dsp.set_playback_rate(rate, hold ? 1 : 0);
  inst.dsp.request_reset();
  return inst;
}

/** Bit equality of two long buffers (toEqual is slow at this size). */
function sameSamples(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Least-squares amplitude of a `freq` sinusoid in channel 0, frames [from, to). */
function toneAmplitude(x: Float32Array, freq: number, from: number, to: number): number {
  let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * freq * i) / RATE;
    const sn = Math.sin(w), cs = Math.cos(w), v = x[2 * i];
    ss += sn * sn; cc += cs * cs; sc += sn * cs; xs += v * sn; xc += v * cs;
  }
  const det = ss * cc - sc * sc;
  return Math.hypot((xs * cc - xc * sc) / det, (xc * ss - xs * sc) / det);
}

/** tests/native/dsp_simd_golden.cpp run(): 8 bands, 1 kHz / 440 Hz stereo, odd chunks. */
function runNativeGoldenVectors(limiter: boolean): Float32Array {
  const inst = instantiate();
  const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000];
  const gains = [6, -3, 4, 0, -6, 2, 9, -12];
  for (let b = 0; b < 8; b++) {
    const type = b === 0 ? 0 : b === 7 ? 2 : 1;
    inst.dsp.set_eq_band(b, type, freqs[b], 1.4, gains[b]);
  }
  inst.dsp.set_replaygain(limiter ? 2.5 : 1, limiter ? 1 : 0);
  const data = new Float32Array(RATE * 2 + 1);
  for (let i = 0; i < data.length; i++) {
    const t = Math.floor(i / 2) / RATE;
    data[i] = 0.9 * Math.sin(2 * Math.PI * (i % 2 ? 440 : 1000) * t);
  }
  const chunks = [1, 7, 256, 3, 1024, 513];
  for (let pos = 0, k = 0; pos < data.length; k++) {
    const n = Math.min(chunks[k % 6], data.length - pos);
    inst.scratch.set(data.subarray(pos, pos + n));
    inst.dsp.process(n, 2, RATE, 0.8);
    data.set(inst.scratch.subarray(0, n), pos);
    pos += n;
  }
  return data;
}

describe('dsp-chain.wasm (dsp_chain.h for the AudioWorklet)', () => {
  it('is bit-identical to the SDL build on the native golden vectors', () => {
    expect(fnv1a(runNativeGoldenVectors(false)).toString(16)).toBe(NATIVE_GOLDEN_FNV1A.limiterOff.toString(16));
    expect(fnv1a(runNativeGoldenVectors(true)).toString(16)).toBe(NATIVE_GOLDEN_FNV1A.limiterOn.toString(16));
  });

  it('exports the pitch-hold and loudness entry points, with fixed memory', () => {
    const module = new WebAssembly.Module(wasmBytes);
    const names = WebAssembly.Module.exports(module).map((e) => e.name);
    for (const name of [
      'set_playback_rate', 'configure_stretch', 'stretch_engaged',
      'loudness_reset', 'loudness_push', 'loudness_momentary', 'loudness_short_term',
    ]) {
      expect(names).toContain(name);
    }
    // standalone-dsp: 6 MiB, growth off (scripts/wasm-flags.sh documents the budget).
    const { dsp } = instantiate();
    expect(dsp.memory.buffer.byteLength).toBe(6 * 1024 * 1024);
    expect(() => dsp.memory.grow(1)).toThrow();
  });

  it('pitch hold at 1.0x is bit-identical to bypass, and matches the native stretch golden', () => {
    const input = stereoSine(1250, 3, 0.5);
    const bypass = run(freshStretchChain(1.25, false), input);
    expect(sameSamples(bypass, input), 'varispeed 1.25x is a bypass').toBe(true);
    const unity = run(freshStretchChain(1, true), input);
    expect(sameSamples(unity, input), '1.0x with pitch hold is a bypass').toBe(true);

    const inst = freshStretchChain(1.25, true);
    const held = run(inst, input);
    expect(inst.dsp.stretch_engaged()).toBe(1);
    expect(fnv1a(held).toString(16)).toBe(STRETCH_GOLDEN_FNV1A.held125.toString(16));
    // A 1 kHz tone played varispeed at 1.25x comes back at 1 kHz.
    const from = RATE / 2, to = held.length / 2 - RATE / 4;
    expect(toneAmplitude(held, 1000, from, to)).toBeCloseTo(0.5, 1);
    expect(toneAmplitude(held, 1250, from, to)).toBeLessThan(0.005);
  }, 30_000);

  it('pitch hold is unavailable above the format cap (the speed control stays varispeed)', () => {
    const { dsp } = instantiate();
    expect(dsp.configure_stretch(8, 96000)).toBe(0);
    expect(dsp.configure_stretch(2, 384000)).toBe(0);
    expect(dsp.configure_stretch(2, 192000)).toBeGreaterThan(0);
    expect(dsp.configure_stretch(8, 48000)).toBeGreaterThan(0);
  });

  it('meters EBU Tech 3341 case 1 (-23 dBFS stereo sine reads -23 LUFS)', () => {
    const { dsp, scratch } = instantiate();
    dsp.loudness_reset(2, RATE);
    expect(Number.isNaN(dsp.loudness_momentary())).toBe(true);
    const amplitude = 10 ** (-23 / 20);
    const input = stereoSine(1000, 4, amplitude);
    for (let pos = 0; pos < input.length; pos += 4096) {
      const piece = input.subarray(pos, Math.min(input.length, pos + 4096));
      scratch.set(piece);
      dsp.loudness_push(piece.length);
    }
    expect(dsp.loudness_momentary()).toBeCloseTo(-23, 1);
    expect(dsp.loudness_short_term()).toBeCloseTo(-23, 1);
  });

  it('needs no imports, so the worklet can instantiate it synchronously', () => {
    const module = new WebAssembly.Module(wasmBytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const names = WebAssembly.Module.exports(module).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([
      'memory', 'scratch_ptr', 'scratch_floats', 'set_eq_band', 'set_replaygain', 'request_reset', 'process',
    ]));
  });

  it('is bit-exact identity with flat EQ, unity ReplayGain and volume', () => {
    const inst = instantiate();
    setGains(inst.dsp, [0, 0, 0, 0, 0]);
    const input = stereoSine(1000, 0.1, 0.8);
    expect(run(inst, input)).toEqual(input);
  });

  it('matches the BiquadFilterNode magnitude response on steady tones', () => {
    const gains = [6, -3, 4, -6, 9];
    for (const freq of [60, 250, 1000, 4000, 12000]) {
      const inst = instantiate();
      setGains(inst.dsp, gains);
      const input = stereoSine(freq, 1, 0.25);
      const out = run(inst, input);
      const half = input.length / 2;
      const measured = rmsDb(out, half) - rmsDb(input, half);
      const expected = DEFAULT_EQ_BANDS.reduce(
        (db, band, i) => db + biquadMagnitudeDb(band.type, band.frequency, band.Q, gains[i], freq),
        0
      );
      expect(Math.abs(measured - expected), `${freq} Hz: ${measured} vs ${expected} dB`).toBeLessThan(TOLERANCE_DB);
    }
  });

  it('applies ReplayGain and volume before the EQ', () => {
    const inst = instantiate();
    setGains(inst.dsp, [0, 0, 0, 0, 0]);
    inst.dsp.set_replaygain(0.5, 0);
    const input = stereoSine(1000, 0.5, 0.5);
    const out = run(inst, input, { volume: 0.5 });
    expect(rmsDb(out, 0) - rmsDb(input, 0)).toBeCloseTo(20 * Math.log10(0.25), 3);
  });

  it('limits hot ReplayGain below 0 dBFS', () => {
    const inst = instantiate();
    setGains(inst.dsp, [0, 0, 0, 0, 0]);
    inst.dsp.set_replaygain(2.5, 1);
    const out = run(inst, stereoSine(1000, 1, 0.9));
    let peak = 0;
    for (let i = out.length / 2; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeLessThan(1);
    expect(peak).toBeGreaterThan(0.8);
  });

  it('does not depend on the render quantum size', () => {
    const gains = [3, 0, -4, 2, 6];
    const input = stereoSine(440, 0.5, 0.6);
    const a = instantiate();
    setGains(a.dsp, gains);
    const b = instantiate();
    setGains(b.dsp, gains);
    expect(run(a, input, { blockFrames: 128 })).toEqual(run(b, input, { blockFrames: 1000 }));
  });

  it('request_reset clears filter history', () => {
    const inst = instantiate();
    setGains(inst.dsp, [0, 0, 12, 0, 0]);
    const input = stereoSine(1000, 0.05, 0.5);
    const first = run(inst, input);
    run(inst, stereoSine(250, 0.05, 0.9));
    inst.dsp.request_reset();
    expect(run(inst, input)).toEqual(first);
  });
});
