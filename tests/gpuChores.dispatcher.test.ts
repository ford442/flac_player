import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runChore,
  gpuEligibility,
  isGpuComputeDisabled,
  GPU_BREAK_EVEN_SAMPLES,
  GPU_MAX_UPLOAD_SAMPLES,
  WORKER_MIN_SAMPLES,
  adoptVisualizerDevice,
  getAdoptedDevice,
  clearGpuChoreBreadcrumbs,
  getLastGpuChoreBreadcrumb,
  reduceMinMax,
} from '../src/gpu-chores';

describe('gpuEligibility / break-even', () => {
  it('skips GPU below the documented sample threshold', () => {
    expect(gpuEligibility(WORKER_MIN_SAMPLES).ok).toBe(false);
    expect(gpuEligibility(WORKER_MIN_SAMPLES).reason).toBe('below-break-even');
    expect(gpuEligibility(GPU_BREAK_EVEN_SAMPLES - 1).reason).toBe('below-break-even');
  });

  it('allows GPU at the break-even and skips above the VRAM cap', () => {
    expect(gpuEligibility(GPU_BREAK_EVEN_SAMPLES)).toEqual({ ok: true, reason: 'gpu-eligible' });
    expect(gpuEligibility(GPU_MAX_UPLOAD_SAMPLES + 1)).toEqual({ ok: false, reason: 'above-vram-cap' });
  });
});

describe('?no_gpu_compute kill switch', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('is off by default', () => {
    window.history.replaceState({}, '', '/');
    expect(isGpuComputeDisabled(window.location.search)).toBe(false);
  });

  it('trips when the query flag is present', () => {
    expect(isGpuComputeDisabled('?no_gpu_compute')).toBe(true);
    expect(isGpuComputeDisabled('?no_gpu_compute=1')).toBe(true);
    expect(isGpuComputeDisabled('?visualizer=webgpu&no_gpu_compute=true')).toBe(true);
  });

  it('ignores an explicit false value', () => {
    expect(isGpuComputeDisabled('?no_gpu_compute=false')).toBe(false);
  });
});

describe('runChore dispatcher', () => {
  beforeEach(() => {
    clearGpuChoreBreadcrumbs();
    adoptVisualizerDevice(null);
    window.history.replaceState({}, '', '/');
  });

  it('honors prefer: cpu and records a breadcrumb', async () => {
    const pcm = new Float32Array([0, 1, -1, 0.5]);
    const result = await runChore({ kind: 'reduce_minmax', pcm, prefer: 'cpu', binCount: 2 });
    expect(result.backend).toBe('cpu');
    expect(result.reason).toBe('prefer-cpu');
    expect(Array.from(result.minmax ?? [])).toEqual(Array.from(reduceMinMax(pcm, 2, 1)));
    expect(getLastGpuChoreBreadcrumb()?.backend).toBe('cpu');
    expect(window.__gpuChores?.last?.reason).toBe('prefer-cpu');
  });

  it('auto-selects CPU for short clips (break-even + no visualizer device)', async () => {
    const pcm = new Float32Array(1024);
    pcm[10] = 0.75;
    pcm[20] = -0.5;
    const result = await runChore({ kind: 'peak_pyramid', pcm, prefer: 'auto', binCount: 8 });
    expect(result.backend).toBe('cpu');
    expect(result.reason).toMatch(/no-visualizer-device/);
    expect(result.reason).toMatch(/below-worker-min/);
    expect(result.minmax).toHaveLength(16);
    expect(result.peak).toBeCloseTo(0.75, 5);
  });

  it('reduce_rms golden via dispatcher', async () => {
    const result = await runChore({
      kind: 'reduce_rms',
      pcm: new Float32Array([1, -1, 1, -1]),
      prefer: 'cpu',
    });
    expect(result.rms).toBeCloseTo(1, 10);
    expect(result.peak).toBe(1);
  });

  it('does not request a GPU device when none is adopted', async () => {
    const requestDevice = vi.fn();
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: vi.fn(), requestDevice },
    });
    expect(getAdoptedDevice()).toBeNull();
    await runChore({ kind: 'reduce_minmax', pcm: new Float32Array(64), prefer: 'auto' });
    expect(requestDevice).not.toHaveBeenCalled();
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
  });

  it('kill switch keeps auto mode off WebGPU even if a device were adopted', async () => {
    window.history.replaceState({}, '', '/?no_gpu_compute');
    const pcm = new Float32Array(64).map((_, i) => (i % 2 === 0 ? 0.2 : -0.1));
    const result = await runChore({ kind: 'reduce_minmax', pcm, prefer: 'auto', binCount: 4 });
    expect(result.backend).not.toBe('webgpu');
    expect(result.reason).toMatch(/kill-switch|no-visualizer-device|below-worker-min|prefer-cpu|cpu/);
  });
});
