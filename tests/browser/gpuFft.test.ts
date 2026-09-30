import { describe, expect, it } from 'vitest';
import { FFT_GPU_EPSILON, fftMagnitudes, reduceFftSpectrum } from '../../src/gpu-chores/fft';
import { runWebGpuFft } from '../../src/gpu-chores/webgpuFft';

/**
 * Real-device check of the WGSL Stockham FFT against the CPU golden.
 * Skips when the headless browser exposes no WebGPU adapter (common in CI).
 */
async function getDevice(): Promise<GPUDevice | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter().catch(() => null);
  return adapter ? adapter.requestDevice() : null;
}

function sine(frames: number, n: number, cycles: number, amplitude: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / n);
  return out;
}

describe('WebGPU fft_spectrum vs CPU golden', async () => {
  const device = await getDevice();

  it.skipIf(!device).each([256, 2048])('matches within FFT_GPU_EPSILON at N=%i', async (n) => {
    const pcm = sine(n * 8 + 17, n, n / 8 + 2, 0.7);
    const gpu = await runWebGpuFft(device!, pcm, 64, 1, n);
    const golden = fftMagnitudes(pcm, 1, n);
    let diff = 0;
    for (let k = 0; k < golden.length; k++) diff = Math.max(diff, Math.abs(golden[k] - gpu.magnitudes[k]));
    expect(diff).toBeLessThan(FFT_GPU_EPSILON);

    const bins = reduceFftSpectrum(pcm, 64, 1, n);
    for (let b = 0; b < bins.length; b++) expect(Math.abs(bins[b] - gpu.spectrum[b])).toBeLessThan(FFT_GPU_EPSILON);
  });
});
