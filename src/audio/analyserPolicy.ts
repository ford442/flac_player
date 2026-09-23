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

export function applyAnalyserPolicy(
  analyser: AnalyserNode,
  policy: Readonly<AnalyserPolicy> = DEFAULT_ANALYSER_POLICY
): void {
  analyser.fftSize = policy.fftSize;
  analyser.smoothingTimeConstant = policy.smoothingTimeConstant;
  analyser.minDecibels = policy.minDecibels;
  analyser.maxDecibels = policy.maxDecibels;
}
