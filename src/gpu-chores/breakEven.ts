import {
  GPU_BREAK_EVEN_SAMPLES,
  GPU_MAX_UPLOAD_SAMPLES,
  MAX_SCRUBBER_BINS,
  MIN_SCRUBBER_BINS,
} from './constants';

export interface GpuEligibility {
  ok: boolean;
  reason: string;
}

export function clampBinCount(binCount: number, fallback: number): number {
  if (!Number.isFinite(binCount) || binCount <= 0) return fallback;
  return Math.max(MIN_SCRUBBER_BINS, Math.min(MAX_SCRUBBER_BINS, Math.floor(binCount)));
}

/**
 * Auto-mode GPU gate. Short clips stay on CPU/Worker; huge buffers stay on
 * Worker to avoid a second VRAM heap beside the visualizer.
 */
export function gpuEligibility(sampleCount: number): GpuEligibility {
  if (sampleCount < GPU_BREAK_EVEN_SAMPLES) {
    return { ok: false, reason: 'below-break-even' };
  }
  if (sampleCount > GPU_MAX_UPLOAD_SAMPLES) {
    return { ok: false, reason: 'above-vram-cap' };
  }
  return { ok: true, reason: 'gpu-eligible' };
}

export function yieldToUi(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
