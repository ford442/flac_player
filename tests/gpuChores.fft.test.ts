import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptVisualizerDevice,
  binFftMagnitudes,
  clearGpuChoreBreadcrumbs,
  FFT_GPU_EPSILON,
  fftMagnitudes,
  reduceFftSpectrum,
  runChore,
  stockhamFftReference,
} from '../src/gpu-chores';
import { fftInterleaved, planFft, windowedSegment } from '../src/gpu-chores/fft';

/** Bin-centered sine fixture: `cycles` whole periods per `n`-frame segment. */
function sine(frames: number, n: number, cycles: number, amplitude: number, channels = 1): Float32Array {
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * cycles * i) / n);
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('fft_spectrum CPU golden', () => {
  it('reads a bin-centered sine at its amplitude on the peak line', () => {
    const n = 1024;
    const mags = fftMagnitudes(sine(n * 4, n, 64, 0.8), 1, n);
    expect(mags).toHaveLength(n / 2);
    let peak = 0;
    for (let k = 1; k < mags.length; k++) if (mags[k] > mags[peak]) peak = k;
    expect(peak).toBe(64);
    // Symmetric Hann (N−1 denominator) is within 0.5% of the periodic coherent gain.
    expect(mags[64]).toBeCloseTo(0.8, 2);
    expect(mags[200]).toBeLessThan(1e-3);
  });

  it('mixes stereo down to mono and averages Welch segments', () => {
    const n = 256;
    const mono = fftMagnitudes(sine(n * 3, n, 10, 0.5, 1), 1, n);
    const stereo = fftMagnitudes(sine(n * 3, n, 10, 0.5, 2), 2, n);
    expect(maxAbsDiff(mono, stereo)).toBeLessThan(1e-6);
    expect(planFft(n * 3 * 2, 2, n).segments).toBe(3);
  });

  it('zero-pads a window shorter than one segment', () => {
    const plan = planFft(100, 1, 256);
    expect(plan.segments).toBe(1);
    const seg = windowedSegment(new Float32Array(100).fill(1), plan, 0);
    expect(seg[200 * 2]).toBe(0);
  });

  it('bins lines by averaging and handles bins narrower than a line', () => {
    const lines = new Float32Array([1, 3, 5, 7]);
    expect(Array.from(binFftMagnitudes(lines, 2))).toEqual([2, 6]);
    expect(Array.from(binFftMagnitudes(lines, 8))).toEqual([1, 1, 3, 3, 5, 5, 7, 7]);
  });

  it('rounds fftSize up to a power of two', () => {
    expect(reduceFftSpectrum(sine(3000, 1000, 5, 1), 16, 1, 1000)).toHaveLength(16);
    expect(planFft(4096, 1, 1000).fftSize).toBe(1024);
  });
});

describe('Stockham kernel (WGSL mirror) vs radix-2 golden', () => {
  it.each([64, 1024, 4096])('matches the golden FFT within FFT_GPU_EPSILON at N=%i', (n) => {
    const pcm = sine(n * 2, n, n / 16 + 3, 0.9);
    const golden = fftMagnitudes(pcm, 1, n, 'radix2');
    const gpuMirror = fftMagnitudes(pcm, 1, n, 'stockham');
    expect(maxAbsDiff(golden, gpuMirror)).toBeLessThan(FFT_GPU_EPSILON);
    expect(maxAbsDiff(binFftMagnitudes(golden, 64), binFftMagnitudes(gpuMirror, 64)))
      .toBeLessThan(FFT_GPU_EPSILON);
  });

  it('produces the full complex spectrum in natural order', () => {
    const n = 32;
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) data[i * 2] = Math.cos((2 * Math.PI * 3 * i) / n);
    const ref = Float32Array.from(data);
    fftInterleaved(ref);
    const out = stockhamFftReference(data);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(ref[i], 4);
    expect(out[3 * 2]).toBeCloseTo(n / 2, 4);
  });
});

describe('runChore fft_spectrum', () => {
  beforeEach(() => {
    clearGpuChoreBreadcrumbs();
    adoptVisualizerDevice(null);
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => {
    adoptVisualizerDevice(null);
    window.history.replaceState({}, '', '/');
  });

  it('returns the CPU golden on the CPU path', async () => {
    const pcm = sine(4096, 1024, 32, 0.5);
    const result = await runChore({ kind: 'fft_spectrum', pcm, prefer: 'cpu', binCount: 32, fftSize: 1024 });
    expect(result.backend).toBe('cpu');
    expect(result.fftSize).toBe(1024);
    expect(Array.from(result.spectrum ?? [])).toEqual(Array.from(reduceFftSpectrum(pcm, 32, 1, 1024)));
  });

  it('?no_gpu_compute skips the adopted device even when forced to webgpu', async () => {
    const createShaderModule = vi.fn(() => { throw new Error('should not compile'); });
    adoptVisualizerDevice({
      lost: new Promise(() => {}),
      createShaderModule,
    } as unknown as GPUDevice);
    window.history.replaceState({}, '', '/?no_gpu_compute');

    const result = await runChore({ kind: 'fft_spectrum', pcm: sine(2048, 1024, 8, 1), prefer: 'webgpu' });
    expect(createShaderModule).not.toHaveBeenCalled();
    expect(result.backend).toBe('cpu');
  });

  it('falls back to the CPU golden when the GPU FFT throws', async () => {
    adoptVisualizerDevice({
      lost: new Promise(() => {}),
      createShaderModule: () => { throw new Error('device flake'); },
    } as unknown as GPUDevice);
    const pcm = sine(2048, 1024, 8, 1);
    const result = await runChore({ kind: 'fft_spectrum', pcm, prefer: 'webgpu', binCount: 8, fftSize: 1024 });
    expect(result.backend).toBe('cpu');
    expect(Array.from(result.spectrum ?? [])).toEqual(Array.from(reduceFftSpectrum(pcm, 8, 1, 1024)));
  });
});
