/**
 * Job API for display-only GPGPU chores (waveform overview, RMS peek, HUD bins).
 *
 * Shape is aligned with a future shared `gpu-chores` package. This folder is the
 * local stub until that package exists. Do not run these jobs inside an audio
 * callback — UI/overview rate only (on load + seek, or ≤ 30–60 Hz meters).
 */

import {
  DEFAULT_SCRUBBER_BINS,
  DEFAULT_SPECTRUM_BINS,
} from './constants';

export type { DecodedPcmView } from '../types/audio';

export type GpuChoreKind =
  | 'reduce_minmax'
  | 'peak_pyramid'
  | 'reduce_rms'
  | 'spectrum_bins';

export type GpuChorePrefer = 'auto' | 'webgpu' | 'worker' | 'cpu';

export type GpuChoreBackend = 'webgpu' | 'worker' | 'cpu';

export interface GpuChoreJob {
  kind: GpuChoreKind;
  pcm: Float32Array;
  channels?: number;
  /** Overview / spectrum bin count. Clamped to 1–4096. */
  binCount?: number;
  prefer?: GpuChorePrefer;
  signal?: AbortSignal;
}

export interface GpuChoreResult {
  kind: GpuChoreKind;
  backend: GpuChoreBackend;
  /** Why this backend was chosen or why a preferred backend was skipped. */
  reason: string;
  /** Interleaved min/max pairs, length = 2 * binCount. */
  minmax?: Float32Array;
  /** Coarser pyramid levels (peak_pyramid only); each is interleaved min/max. */
  levels?: Float32Array[];
  rms?: number;
  peak?: number;
  /** Optional HUD spectrum magnitudes, length = binCount. */
  spectrum?: Float32Array;
  elapsedMs: number;
  sampleCount: number;
  binCount: number;
}

export interface GpuChoreBreadcrumb {
  kind: GpuChoreKind;
  backend: GpuChoreBackend;
  reason: string;
  samples: number;
  bins: number;
  elapsedMs: number;
  prefer: GpuChorePrefer;
  timestamp: string;
}

export const GPU_CHORE_DEFAULTS = {
  channels: 1,
  scrubberBins: DEFAULT_SCRUBBER_BINS,
  spectrumBins: DEFAULT_SPECTRUM_BINS,
  prefer: 'auto' as GpuChorePrefer,
};
