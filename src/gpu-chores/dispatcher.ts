/**
 * gpu-chores dispatcher.
 *
 * Backend order for `prefer: 'auto'`:
 *   1. WebGPU compute if the visualizer already owns a device (adopt it)
 *   2. Worker TS reduce
 *   3. Main-thread CPU last
 *
 * WebGL2 compute-via-FBO is intentionally not used. Kill switch: `?no_gpu_compute`.
 * Failures never throw out of `runChore` for auto mode — CPU goldens always work.
 */

import { DEFAULT_SCRUBBER_BINS, DEFAULT_SPECTRUM_BINS, WORKER_MIN_SAMPLES } from './constants';
import { clampBinCount, gpuEligibility, yieldToUi } from './breakEven';
import { recordGpuChoreBreadcrumb } from './breadcrumbs';
import { getAdoptedDevice } from './device';
import { isGpuComputeDisabled } from './killSwitch';
import {
  peakPyramid,
  pyramidFromMinMax,
  reduceMinMax,
  reduceRms,
  reduceSpectrum,
} from './reduce';
import { runWebGpuReduce } from './webgpuReduce';
import { runWorkerChore } from './workerClient';
import type { GpuChoreBackend, GpuChoreJob, GpuChorePrefer, GpuChoreResult } from './types';

function defaultBinsFor(kind: GpuChoreJob['kind']): number {
  return kind === 'spectrum_bins' ? DEFAULT_SPECTRUM_BINS : DEFAULT_SCRUBBER_BINS;
}

function cpuResult(job: GpuChoreJob, reason: string, started: number): GpuChoreResult {
  const channels = Math.max(1, job.channels ?? 1);
  const binCount = clampBinCount(job.binCount ?? defaultBinsFor(job.kind), defaultBinsFor(job.kind));
  const base: GpuChoreResult = {
    kind: job.kind,
    backend: 'cpu',
    reason,
    elapsedMs: 0,
    sampleCount: job.pcm.length,
    binCount,
  };

  if (job.kind === 'reduce_rms') {
    const peek = reduceRms(job.pcm);
    base.rms = peek.rms;
    base.peak = peek.peak;
  } else if (job.kind === 'spectrum_bins') {
    base.spectrum = reduceSpectrum(job.pcm, binCount, channels);
  } else if (job.kind === 'peak_pyramid') {
    const levels = peakPyramid(job.pcm, binCount, channels);
    base.levels = levels;
    base.minmax = levels[0];
    const peek = reduceRms(job.pcm);
    base.rms = peek.rms;
    base.peak = peek.peak;
  } else {
    base.minmax = reduceMinMax(job.pcm, binCount, channels);
    const peek = reduceRms(job.pcm);
    base.rms = peek.rms;
    base.peak = peek.peak;
  }
  base.elapsedMs = performance.now() - started;
  return base;
}

async function cpuResultAsync(job: GpuChoreJob, reason: string, started: number): Promise<GpuChoreResult> {
  if (job.pcm.length > WORKER_MIN_SAMPLES) {
    await yieldToUi();
  }
  return cpuResult(job, reason, started);
}

function finish(
  result: GpuChoreResult,
  prefer: GpuChorePrefer,
): GpuChoreResult {
  recordGpuChoreBreadcrumb({
    kind: result.kind,
    backend: result.backend,
    reason: result.reason,
    samples: result.sampleCount,
    bins: result.binCount,
    elapsedMs: result.elapsedMs,
    prefer,
    timestamp: new Date().toISOString(),
  });
  return result;
}

async function tryWebGpu(job: GpuChoreJob, prefer: GpuChorePrefer): Promise<GpuChoreResult | null> {
  if (prefer !== 'auto' && prefer !== 'webgpu') return null;
  if (isGpuComputeDisabled()) return null;
  if (job.kind === 'spectrum_bins') return null;

  const device = getAdoptedDevice();
  if (!device) return null;

  const eligibility = gpuEligibility(job.pcm.length);
  if (!eligibility.ok && prefer === 'auto') return null;

  const channels = Math.max(1, job.channels ?? 1);
  const binCount = clampBinCount(job.binCount ?? defaultBinsFor(job.kind), defaultBinsFor(job.kind));
  const started = performance.now();
  try {
    const gpu = await runWebGpuReduce(device, job.pcm, binCount, channels, job.kind, job.signal);
    const result: GpuChoreResult = {
      kind: job.kind,
      backend: 'webgpu',
      reason: eligibility.ok ? 'adopted-visualizer-device' : `forced-webgpu:${eligibility.reason}`,
      minmax: job.kind === 'reduce_rms' ? undefined : gpu.minmax,
      levels: job.kind === 'peak_pyramid' ? pyramidFromMinMax(gpu.minmax) : undefined,
      rms: gpu.rms,
      peak: gpu.peak,
      elapsedMs: performance.now() - started,
      sampleCount: job.pcm.length,
      binCount,
    };
    return finish(result, prefer);
  } catch {
    // Chrome vs Edge WebGPU flakes must not take down playback.
    return null;
  }
}

async function tryWorker(job: GpuChoreJob, prefer: GpuChorePrefer): Promise<GpuChoreResult | null> {
  if (prefer !== 'auto' && prefer !== 'worker') return null;
  if (typeof Worker === 'undefined') return null;
  if (prefer === 'auto' && job.pcm.length < WORKER_MIN_SAMPLES) return null;

  try {
    const result = await runWorkerChore(job);
    return finish(result, prefer);
  } catch (error) {
    if (prefer === 'worker') {
      const reason = `worker-failed:${error instanceof Error ? error.message : String(error)}`;
      return finish(await cpuResultAsync(job, reason, performance.now()), prefer);
    }
    return null;
  }
}

/**
 * Run a display chore. Never throws for `prefer: 'auto'` — CPU goldens are last.
 * Call from UI/overview code only, never from an audio callback.
 */
export async function runChore(job: GpuChoreJob): Promise<GpuChoreResult> {
  const prefer: GpuChorePrefer = job.prefer ?? 'auto';
  const started = performance.now();

  if (job.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (prefer === 'cpu') {
    return finish(cpuResult(job, 'prefer-cpu', started), prefer);
  }

  const gpu = await tryWebGpu(job, prefer);
  if (gpu) return gpu;

  const worker = await tryWorker(job, prefer);
  if (worker) return worker;

  const skipReasons: string[] = [];
  if (isGpuComputeDisabled()) skipReasons.push('kill-switch');
  if (!getAdoptedDevice()) skipReasons.push('no-visualizer-device');
  else {
    const eligibility = gpuEligibility(job.pcm.length);
    if (!eligibility.ok) skipReasons.push(eligibility.reason);
  }
  if (typeof Worker === 'undefined' || job.pcm.length < WORKER_MIN_SAMPLES) {
    skipReasons.push('below-worker-min');
  }
  const reason = skipReasons.join(',') || 'cpu-fallback';
  return finish(await cpuResultAsync(job, reason, started), prefer);
}

export function describeChoreBackend(backend: GpuChoreBackend): string {
  switch (backend) {
    case 'webgpu': return 'WebGPU compute (adopted visualizer device)';
    case 'worker': return 'Worker TS reduce';
    default: return 'Main-thread CPU';
  }
}
