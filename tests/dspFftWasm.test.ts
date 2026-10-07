import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { WasmFft } from '../src/audio/wasmFft';
import {
  binFftMagnitudes,
  clampFftSize,
  FFT_GPU_EPSILON,
  fftMagnitudes,
  reduceFftSpectrum,
} from '../src/gpu-chores/fft';

// Golden checks for src/sdl/dsp_fft.h compiled into public/dsp-chain.wasm
// (src/dsp/dsp_wasm_entry.cpp `fft_spectrum`), driven through WasmFft exactly as
// the live spectrum hook does. The f64 JS golden (src/gpu-chores/fft.ts) is the
// definition; dsp_fft.h computes in f32 like the WGSL kernel, so the documented
// CPU-vs-GPU epsilon is the bound here too.

const wasmBytes = readFileSync(path.resolve(__dirname, '../public/dsp-chain.wasm'));

function fft(): WasmFft {
  return WasmFft.fromModule(new WebAssembly.Module(wasmBytes));
}

/** Deterministic white noise in [-1, 1) (xorshift32). */
function noise(samples: number, seed = 0x9e3779b9): Float32Array {
  const out = new Float32Array(samples);
  let x = seed >>> 0;
  for (let i = 0; i < samples; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x / 2 ** 31 - 1;
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

describe('dsp_fft.h in dsp-chain.wasm (fft_spectrum CPU golden)', () => {
  it('exports the spectrum ABI and still needs no imports', () => {
    const module = new WebAssembly.Module(wasmBytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const names = WebAssembly.Module.exports(module).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['fft_spectrum', 'fft_out_ptr', 'fft_lines_ptr']));
  });

  it.each([
    { label: 'mono N=64', channels: 1, frames: 64, fftSize: 64 },
    { label: 'mono N=2048', channels: 1, frames: 2048, fftSize: 2048 },
    { label: 'stereo N=2048, 3.5 Welch segments', channels: 2, frames: 3584, fftSize: 1024 },
    { label: 'stereo N=16384 (largest window)', channels: 2, frames: 16384, fftSize: 16384 },
    { label: '5.1 N=512, zero-padded short input', channels: 6, frames: 300, fftSize: 512 },
  ])('matches the JS golden within FFT_GPU_EPSILON: $label', ({ channels, frames, fftSize }) => {
    const pcm = noise(frames * channels);
    const result = fft().spectrum(pcm, channels, fftSize, 64);
    expect(result.fftSize).toBe(fftSize);
    expect(maxAbsDiff(result.spectrum, reduceFftSpectrum(pcm, 64, channels, fftSize))).toBeLessThan(FFT_GPU_EPSILON);
    // Raw lines against the Stockham mirror of the WGSL kernel as well.
    const lines = fftMagnitudes(pcm, channels, fftSize, 'stockham');
    expect(maxAbsDiff(result.magnitudes, lines)).toBeLessThan(FFT_GPU_EPSILON);
  });

  it('reads a full-scale sine centered on bin k as amplitude ≈ 1', () => {
    const inst = fft();
    for (const n of [256, 2048, 8192]) {
      const k = n / 8;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = Math.sin((2 * Math.PI * k * i) / n);
      const { magnitudes } = inst.spectrum(pcm, 1, n, 64);
      expect(magnitudes[k]).toBeCloseTo(1, 4);
      // Hann main lobe: neighbours at half amplitude. The window is symmetric
      // (N−1 denominator, not periodic), so far bins leak slightly above zero.
      expect(magnitudes[k + 1]).toBeCloseTo(0.5, 2);
      expect(magnitudes[k + 4]).toBeLessThan(1e-3);
    }
  });

  it('SIMD stages are bit-identical to the scalar stages', () => {
    const inst = fft();
    for (const n of [64, 1024, 16384]) {
      const pcm = noise(n * 2, n);
      const simd = inst.spectrum(pcm, 2, n, 4096);
      const scalar = inst.spectrum(pcm, 2, n, 4096, { simd: false });
      expect(simd.magnitudes).toEqual(scalar.magnitudes);
      expect(simd.spectrum).toEqual(scalar.spectrum);
    }
  });

  it('clamps fftSize exactly like clampFftSize', () => {
    const inst = fft();
    const pcm = noise(4096);
    for (const size of [0, -5, 1, 100, 1000, 2048, 3000, 30000]) {
      expect(inst.spectrum(pcm, 1, size, 16).fftSize, `size ${size}`).toBe(clampFftSize(size));
    }
  });

  it('bins like binFftMagnitudes, including more bins than lines', () => {
    const inst = fft();
    const pcm = noise(64);
    const result = inst.spectrum(pcm, 1, 64, 100);
    expect(result.spectrum).toHaveLength(100);
    expect(maxAbsDiff(result.spectrum, binFftMagnitudes(result.magnitudes, 100))).toBe(0);
    expect(inst.spectrum(pcm, 1, 64, 0).spectrum).toHaveLength(64);
    expect(inst.spectrum(pcm, 1, 64, 1e6).spectrum).toHaveLength(4096);
  });

  it('rejects input larger than its scratch instead of truncating', () => {
    const inst = fft();
    expect(inst.maxSamples).toBe(32768);
    expect(() => inst.spectrum(new Float32Array(inst.maxSamples + 1), 1, 2048, 64)).toThrow(RangeError);
  });
});
