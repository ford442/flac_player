/**
 * Explicit AnalyserNode policy for the shared player graph
 * (AudioContextManager.buildGraph). Browser defaults are not relied on.
 */
export interface AnalyserPolicy {
  fftSize: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
}

export const DEFAULT_ANALYSER_POLICY: Readonly<AnalyserPolicy> = Object.freeze({
  fftSize: 2048,
  smoothingTimeConstant: 0.8,
  minDecibels: -100,
  maxDecibels: -30,
});

/**
 * fftSize for a context rate: keeps the bin width near the 44.1/48 kHz value
 * (~22 Hz) so high-rate graphs keep their bass resolution (#259 A6).
 * 4096 at ≥ 88.2 kHz, 8192 at ≥ 176.4 kHz, `base` below that.
 */
export function analyserFftSizeForRate(
  sampleRate: number | undefined,
  base: number = DEFAULT_ANALYSER_POLICY.fftSize
): number {
  if (!sampleRate || !Number.isFinite(sampleRate)) return base;
  if (sampleRate >= 176_400) return Math.max(base, 8192);
  if (sampleRate >= 88_200) return Math.max(base, 4096);
  return base;
}

/**
 * Apply `policy` to `analyser`. fftSize is scaled for the analyser's context rate
 * ({@link analyserFftSizeForRate}); pass `sampleRate` to override that read.
 */
export function applyAnalyserPolicy(
  analyser: AnalyserNode,
  policy: Readonly<AnalyserPolicy> = DEFAULT_ANALYSER_POLICY,
  sampleRate: number | undefined = analyser.context?.sampleRate
): void {
  analyser.fftSize = analyserFftSizeForRate(sampleRate, policy.fftSize);
  analyser.smoothingTimeConstant = policy.smoothingTimeConstant;
  analyser.minDecibels = policy.minDecibels;
  analyser.maxDecibels = policy.maxDecibels;
}
