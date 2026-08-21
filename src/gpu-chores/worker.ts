/// <reference lib="webworker" />

import {
  accumulateOverviewChunk,
  createOverviewAccumulator,
  finalizeOverview,
  reduceSpectrum,
} from './reduce';
import type { GpuChoreKind } from './types';
import type { WorkerInbound, WorkerOutbound } from './protocol';

interface JobState {
  kind: GpuChoreKind;
  acc: ReturnType<typeof createOverviewAccumulator>;
  started: number;
  spectrumPcm: Float32Array | null;
  spectrumOffset: number;
}

const jobs = new Map<number, JobState>();

function fail(id: number, error: string, started: number): void {
  const msg: WorkerOutbound = {
    id,
    ok: false,
    error,
    elapsedMs: performance.now() - started,
  };
  self.postMessage(msg);
}

self.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const data = event.data;
  try {
    if (data.type === 'start') {
      jobs.set(data.id, {
        kind: data.kind,
        acc: createOverviewAccumulator(data.totalSamples, data.binCount, data.channels),
        started: performance.now(),
        spectrumPcm: data.kind === 'spectrum_bins' ? new Float32Array(data.totalSamples) : null,
        spectrumOffset: 0,
      });
      return;
    }

    if (data.type === 'chunk') {
      const job = jobs.get(data.id);
      if (!job) {
        fail(data.id, 'unknown-job', performance.now());
        return;
      }
      accumulateOverviewChunk(job.acc, data.pcm, data.sampleOffset);
      if (job.spectrumPcm) {
        job.spectrumPcm.set(data.pcm, job.spectrumOffset);
        job.spectrumOffset += data.pcm.length;
      }
      return;
    }

    if (data.type === 'finish') {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (!job) {
        fail(data.id, 'unknown-job', performance.now());
        return;
      }
      const overview = finalizeOverview(job.acc);
      const elapsedMs = performance.now() - job.started;
      const transfer: Transferable[] = [];
      const msg: WorkerOutbound = {
        id: data.id,
        ok: true,
        elapsedMs,
      };

      if (job.kind === 'reduce_rms') {
        msg.rms = overview.rms;
        msg.peak = overview.peak;
      } else if (job.kind === 'spectrum_bins') {
        const spectrum = reduceSpectrum(
          job.spectrumPcm ?? new Float32Array(0),
          job.acc.binCount,
          job.acc.channels,
        );
        msg.spectrum = spectrum;
        transfer.push(spectrum.buffer);
      } else {
        msg.minmax = overview.minmax;
        msg.rms = overview.rms;
        msg.peak = overview.peak;
        transfer.push(overview.minmax.buffer);
      }

      self.postMessage(msg, transfer);
    }
  } catch (error) {
    fail(data.id, error instanceof Error ? error.message : String(error), performance.now());
  }
};
