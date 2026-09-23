/**
 * `fft_spectrum` — CPU golden + JS mirror of the WGSL Stockham kernel.
 *
 * Definition (shared by CPU, Worker, and WebGPU paths):
 *   1. Mono mixdown: mean of the interleaved channels per frame.
 *   2. Split into non-overlapping segments of `fftSize` frames (Welch, hop = fftSize).
 *      Fewer frames than one segment → a single zero-padded segment; a trailing
 *      partial segment is dropped otherwise.
 *   3. Symmetric Hann window w[i] = 0.5·(1 − cos(2πi/(N−1))).
 *   4. |X[k]| for k in [0, N/2), amplitude-normalized by 2/Σw — a full-scale sine
 *      centered on bin k reads ≈ its amplitude (1.0), independent of N.
 *   5. Mean over segments, then averaged into `binCount` linear HUD bins
 *      (a bin narrower than one FFT line takes the line it starts on).
 *
 * Unlike `reduceSpectrum` (single ≤2048 window, normalized to its own max — a toy
 * HUD binning), this output is absolute, so CPU vs GPU can be compared directly.
 * GPU vs CPU tolerance: FFT_GPU_EPSILON (absolute, on the 0–1 amplitude scale).
 */

import { clampBinCount } from './breakEven';
import {
  DEFAULT_FFT_SIZE,
  DEFAULT_SPECTRUM_BINS,
  MAX_FFT_SIZE,
  MIN_FFT_SIZE,
} from './constants';

/** Documented CPU-vs-GPU epsilon for `fft_spectrum` (f32 twiddles on the GPU). */
export const FFT_GPU_EPSILON = 1e-4;

export function clampFftSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size) || size <= 0) return DEFAULT_FFT_SIZE;
  let p = MIN_FFT_SIZE;
  while (p < size && p < MAX_FFT_SIZE) p <<= 1;
  return p;
}

export interface FftPlan {
  fftSize: number;
  segments: number;
  frames: number;
  channels: number;
  /** 2 / Σw — amplitude normalization. */
  norm: number;
}

export function hannWindow(i: number, n: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
}

export function planFft(sampleCount: number, channels: number, fftSize?: number): FftPlan {
  const n = clampFftSize(fftSize);
  const ch = Math.max(1, channels | 0);
  const frames = Math.floor(sampleCount / ch);
  const segments = Math.max(1, Math.floor(frames / n));
  let windowSum = 0;
  for (let i = 0; i < n; i++) windowSum += hannWindow(i, n);
  return { fftSize: n, segments, frames, channels: ch, norm: windowSum > 0 ? 2 / windowSum : 0 };
}

/** Windowed mono segment `seg` as interleaved complex (re, im). Mirrors the WGSL `window_main`. */
export function windowedSegment(pcm: Float32Array, plan: FftPlan, seg: number): Float32Array {
  const { fftSize: n, channels: ch, frames } = plan;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const frame = seg * n + i;
    let s = 0;
    if (frame < frames) {
      for (let c = 0; c < ch; c++) s += pcm[frame * ch + c] ?? 0;
      s /= ch;
    }
    out[i * 2] = s * hannWindow(i, n);
  }
  return out;
}

/** In-place iterative radix-2 FFT on interleaved complex data (the CPU golden). */
export function fftInterleaved(data: Float32Array): void {
  const n = data.length >> 1;
  for (let i = 0, j = 0; i < n; i++) {
    if (i < j) {
      const tr = data[i * 2]; data[i * 2] = data[j * 2]; data[j * 2] = tr;
      const ti = data[i * 2 + 1]; data[i * 2 + 1] = data[j * 2 + 1]; data[j * 2 + 1] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const e = (i + k) * 2;
        const o = (i + k + half) * 2;
        const tr = wr * data[o] - wi * data[o + 1];
        const ti = wr * data[o + 1] + wi * data[o];
        data[o] = data[e] - tr;
        data[o + 1] = data[e + 1] - ti;
        data[e] += tr;
        data[e + 1] += ti;
      }
    }
  }
}

/** f64 twiddle table rounded to f32: [cos, sin] of −2π·m/n for m in [0, n/2). Uploaded to the GPU. */
export function fftTwiddles(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  for (let m = 0; m < n / 2; m++) {
    const angle = (-2 * Math.PI * m) / n;
    out[m * 2] = Math.cos(angle);
    out[m * 2 + 1] = Math.sin(angle);
  }
  return out;
}

/**
 * Radix-2 Stockham autosort FFT, one pass per stage with ping-pong buffers.
 * Line-for-line mirror of the WGSL `stage_main` kernel in webgpuFft.ts, with
 * the same f32 twiddle table the GPU reads. Returns the buffer holding the result.
 */
export function stockhamFftReference(input: Float32Array): Float32Array {
  const n = input.length >> 1;
  const half = n >> 1;
  const twiddles = fftTwiddles(n);
  let src = Float32Array.from(input);
  let dst = new Float32Array(input.length);
  for (let ns = 1; ns < n; ns <<= 1) {
    for (let j = 0; j < half; j++) {
      const k = j % ns;
      const t = k * (n / (2 * ns));
      const wr = twiddles[t * 2];
      const wi = twiddles[t * 2 + 1];
      const v0r = src[j * 2];
      const v0i = src[j * 2 + 1];
      const v1r0 = src[(j + half) * 2];
      const v1i0 = src[(j + half) * 2 + 1];
      const v1r = v1r0 * wr - v1i0 * wi;
      const v1i = v1r0 * wi + v1i0 * wr;
      const idx = Math.floor(j / ns) * ns * 2 + k;
      dst[idx * 2] = v0r + v1r;
      dst[idx * 2 + 1] = v0i + v1i;
      dst[(idx + ns) * 2] = v0r - v1r;
      dst[(idx + ns) * 2 + 1] = v0i - v1i;
    }
    const t = src; src = dst; dst = t;
  }
  return src;
}

/** Average N/2 FFT lines into `binCount` HUD bins (shared by every backend). */
export function binFftMagnitudes(mags: Float32Array, binCount: number): Float32Array {
  const lines = mags.length;
  const out = new Float32Array(binCount);
  if (lines === 0) return out;
  for (let b = 0; b < binCount; b++) {
    const start = Math.min(lines - 1, Math.floor((b * lines) / binCount));
    const end = Math.floor(((b + 1) * lines) / binCount);
    if (end <= start) {
      out[b] = mags[start];
      continue;
    }
    let sum = 0;
    for (let i = start; i < end; i++) sum += mags[i];
    out[b] = sum / (end - start);
  }
  return out;
}

export type FftKernel = 'radix2' | 'stockham';

/** Segment-averaged, amplitude-normalized magnitudes (length fftSize/2). */
export function fftMagnitudes(
  pcm: Float32Array,
  channels = 1,
  fftSize?: number,
  kernel: FftKernel = 'radix2',
): Float32Array {
  const plan = planFft(pcm.length, channels, fftSize);
  const lines = plan.fftSize >> 1;
  const acc = new Float64Array(lines);
  for (let seg = 0; seg < plan.segments; seg++) {
    let data = windowedSegment(pcm, plan, seg);
    if (kernel === 'stockham') data = stockhamFftReference(data);
    else fftInterleaved(data);
    for (let k = 0; k < lines; k++) acc[k] += Math.hypot(data[k * 2], data[k * 2 + 1]);
  }
  const mags = new Float32Array(lines);
  const scale = plan.norm / plan.segments;
  for (let k = 0; k < lines; k++) mags[k] = acc[k] * scale;
  return mags;
}

/** CPU golden for `kind: 'fft_spectrum'`. */
export function reduceFftSpectrum(
  pcm: Float32Array,
  binCount = DEFAULT_SPECTRUM_BINS,
  channels = 1,
  fftSize?: number,
): Float32Array {
  const bins = clampBinCount(binCount, DEFAULT_SPECTRUM_BINS);
  return binFftMagnitudes(fftMagnitudes(pcm, channels, fftSize), bins);
}
