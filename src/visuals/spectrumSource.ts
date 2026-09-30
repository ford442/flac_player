/**
 * Which FFT drives ShaderGUI spectrum uniforms + beat detection.
 *
 *   ?no_gpu_compute   → analyser (kill switch wins over everything)
 *   ?analyser_fft=1   → analyser (rollback once GPU is the default)
 *   ?gpu_fft=1        → gpu, promoted only while the CPU golden agrees
 *   default           → GPU_SPECTRUM_DEFAULT
 *
 * "gpu" is a request: until {@link GoldenTrust} has seen
 * GPU_SPECTRUM_TRUST_CHECKS consecutive golden checks (~1 Hz) within
 * FFT_GPU_EPSILON, the analyser keeps driving the shader, and a single failed
 * check demotes back to the analyser.
 */
import { FFT_GPU_EPSILON } from '../gpu-chores/fft';
import { isGpuComputeDisabled } from '../gpu-chores/killSwitch';

export type SpectrumSource = 'analyser' | 'gpu';

/** Flip to 'gpu' once goldens are trusted in the field; `?analyser_fft=1` stays the rollback. */
export const GPU_SPECTRUM_DEFAULT: SpectrumSource = 'analyser';

/** Consecutive passing golden checks (~1 s apart) before GPU bins drive the shader. */
export const GPU_SPECTRUM_TRUST_CHECKS = 3;

/** Max |GPU − CPU golden| allowed on a check (the documented fft_spectrum epsilon). */
export const GPU_SPECTRUM_TRUST_EPSILON = FFT_GPU_EPSILON;

function flag(params: URLSearchParams, key: string): boolean {
  if (!params.has(key)) return false;
  const value = params.get(key);
  return value === '' || value === '1' || value === 'true' || value === 'yes';
}

export interface SpectrumSourceChoice {
  source: SpectrumSource;
  reason: 'kill-switch' | 'analyser_fft' | 'gpu_fft' | 'default';
}

export function resolveSpectrumSource(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): SpectrumSourceChoice {
  if (isGpuComputeDisabled(search)) return { source: 'analyser', reason: 'kill-switch' };
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (flag(params, 'analyser_fft')) return { source: 'analyser', reason: 'analyser_fft' };
  if (flag(params, 'gpu_fft')) return { source: 'gpu', reason: 'gpu_fft' };
  return { source: GPU_SPECTRUM_DEFAULT, reason: 'default' };
}

/** Consecutive-pass gate on the ~1 Hz golden check. */
export class GoldenTrust {
  private passes = 0;

  constructor(
    private readonly required = GPU_SPECTRUM_TRUST_CHECKS,
    private readonly epsilon = GPU_SPECTRUM_TRUST_EPSILON,
  ) {}

  /** Record one check; returns whether GPU bins are trusted afterwards. */
  record(maxDiff: number): boolean {
    this.passes = Number.isFinite(maxDiff) && maxDiff <= this.epsilon ? this.passes + 1 : 0;
    return this.trusted;
  }

  get trusted(): boolean {
    return this.passes >= this.required;
  }

  reset(): void {
    this.passes = 0;
  }
}

/**
 * AnalyserNode magnitudes are |X[k]|/N after a Blackman window, so a full-scale
 * sine reads Σw/(2N) ≈ 0.42/2. fft_spectrum is amplitude-normalized (sine → 1.0).
 * Scaling by this before the dB mapping lines the two up on the same byte scale.
 */
export const ANALYSER_AMPLITUDE_SCALE = 0.21;

export interface AnalyserScale {
  minDecibels: number;
  maxDecibels: number;
  smoothingTimeConstant: number;
}

/**
 * Map fft_spectrum amplitudes onto getByteFrequencyData's 0..255 scale, including
 * the analyser's temporal smoothing (on linear magnitude, as the spec does).
 * `smoothed` carries state between calls and is updated in place.
 */
export function amplitudesToAnalyserBytes(
  spectrum: Float32Array,
  scale: AnalyserScale,
  smoothed: Float32Array,
  out: Uint8Array = new Uint8Array(spectrum.length),
): Uint8Array {
  const tau = Math.max(0, Math.min(1, scale.smoothingTimeConstant));
  const range = scale.maxDecibels - scale.minDecibels;
  for (let i = 0; i < spectrum.length; i++) {
    const mag = tau * (smoothed[i] ?? 0) + (1 - tau) * spectrum[i]! * ANALYSER_AMPLITUDE_SCALE;
    smoothed[i] = mag;
    const db = mag > 0 ? 20 * Math.log10(mag) : -Infinity;
    const byte = range > 0 ? (255 / range) * (db - scale.minDecibels) : 0;
    out[i] = byte <= 0 ? 0 : byte >= 255 ? 255 : Math.floor(byte);
  }
  return out;
}
