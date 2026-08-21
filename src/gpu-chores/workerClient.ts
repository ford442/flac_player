/**
 * Worker host for CPU reduce goldens. PCM is copied in chunks so the playback
 * buffer is never transferred away from the audio backend.
 */

import { DEFAULT_SCRUBBER_BINS, DEFAULT_SPECTRUM_BINS, WORKER_CHUNK_SAMPLES } from './constants';
import { clampBinCount } from './breakEven';
import { pyramidFromMinMax } from './reduce';
import type { GpuChoreJob, GpuChoreResult } from './types';
import type { WorkerChunk, WorkerFinish, WorkerOutbound, WorkerStart } from './protocol';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, {
  resolve: (value: WorkerOutbound) => void;
  reject: (reason?: unknown) => void;
}>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url));
  worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
    const msg = event.data;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.resolve(msg);
  };
  worker.onerror = (event) => {
    const err = event.message || 'gpu-chores worker error';
    pending.forEach((waiter) => waiter.reject(new Error(err)));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function request(id: number): Promise<WorkerOutbound> {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

export function disposeGpuChoreWorker(): void {
  pending.forEach((waiter) => waiter.reject(new Error('worker disposed')));
  pending.clear();
  worker?.terminate();
  worker = null;
}

export async function runWorkerChore(job: GpuChoreJob): Promise<GpuChoreResult> {
  const channels = Math.max(1, job.channels ?? 1);
  const defaultBins = job.kind === 'spectrum_bins' ? DEFAULT_SPECTRUM_BINS : DEFAULT_SCRUBBER_BINS;
  const binCount = clampBinCount(job.binCount ?? defaultBins, defaultBins);
  const host = getWorker();
  const id = nextId++;
  const started = performance.now();
  const done = request(id);

  const start: WorkerStart = {
    type: 'start',
    id,
    kind: job.kind,
    channels,
    binCount,
    totalSamples: job.pcm.length,
  };
  host.postMessage(start);

  for (let offset = 0; offset < job.pcm.length; offset += WORKER_CHUNK_SAMPLES) {
    if (job.signal?.aborted) {
      pending.delete(id);
      throw new DOMException('Aborted', 'AbortError');
    }
    const end = Math.min(job.pcm.length, offset + WORKER_CHUNK_SAMPLES);
    const chunk = job.pcm.slice(offset, end);
    const msg: WorkerChunk = { type: 'chunk', id, pcm: chunk, sampleOffset: offset };
    host.postMessage(msg, [chunk.buffer]);
  }

  const finish: WorkerFinish = { type: 'finish', id };
  host.postMessage(finish);

  const response = await done;
  if (!response.ok) {
    throw new Error(response.error || 'gpu-chores worker failed');
  }

  return {
    kind: job.kind,
    backend: 'worker',
    reason: 'worker',
    minmax: response.minmax,
    levels: job.kind === 'peak_pyramid' && response.minmax
      ? pyramidFromMinMax(response.minmax)
      : undefined,
    rms: response.rms,
    peak: response.peak,
    spectrum: response.spectrum,
    elapsedMs: performance.now() - started,
    sampleCount: job.pcm.length,
    binCount,
  };
}
