/**
 * gpu-chores — display-only GPGPU / Worker reduce stub.
 *
 * Decoder, playlist, and projectM are unchanged. Waveform *shaders* (WGSL/GLSL)
 * stay in `src/shaders` / `src/visuals` (#182). This module only reduces PCM
 * to a small overview (peaks, RMS, optional HUD bins).
 */

export {
  GPU_CHORES_WORKGROUP_SIZE,
  DEFAULT_SCRUBBER_BINS,
  DEFAULT_SPECTRUM_BINS,
  GPU_BREAK_EVEN_SAMPLES,
  GPU_MAX_UPLOAD_SAMPLES,
  WORKER_MIN_SAMPLES,
  METER_HZ,
} from './constants';

export type {
  GpuChoreKind,
  GpuChorePrefer,
  GpuChoreBackend,
  GpuChoreJob,
  GpuChoreResult,
  GpuChoreBreadcrumb,
  DecodedPcmView,
} from './types';

export { runChore, describeChoreBackend } from './dispatcher';
export {
  reduceMinMax,
  reduceRms,
  peakPyramid,
  reduceSpectrum,
  downsampleMinMaxPairs,
  pyramidFromMinMax,
} from './reduce';
export { isGpuComputeDisabled } from './killSwitch';
export { gpuEligibility, clampBinCount } from './breakEven';
export {
  adoptVisualizerDevice,
  releaseVisualizerDevice,
  getAdoptedDevice,
  hasAdoptedVisualizerDevice,
} from './device';
export {
  getLastGpuChoreBreadcrumb,
  getGpuChoreHistory,
  clearGpuChoreBreadcrumbs,
  subscribeGpuChoreBreadcrumbs,
} from './breadcrumbs';
export { disposeGpuChoreWorker } from './workerClient';
