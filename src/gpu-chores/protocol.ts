import type { GpuChoreKind } from './types';

export interface WorkerStart {
  type: 'start';
  id: number;
  kind: GpuChoreKind;
  channels: number;
  binCount: number;
  totalSamples: number;
}

export interface WorkerChunk {
  type: 'chunk';
  id: number;
  pcm: Float32Array;
  sampleOffset: number;
}

export interface WorkerFinish {
  type: 'finish';
  id: number;
}

export type WorkerInbound = WorkerStart | WorkerChunk | WorkerFinish;

export interface WorkerOutbound {
  id: number;
  ok: boolean;
  minmax?: Float32Array;
  rms?: number;
  peak?: number;
  spectrum?: Float32Array;
  error?: string;
  elapsedMs: number;
}
