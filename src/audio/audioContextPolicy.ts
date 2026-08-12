export type LatencyMode = 'playback' | 'interactive' | 'balanced';

export type AudioContextLatencyCategory = NonNullable<AudioContextOptions['latencyHint']>;

export interface AudioContextOptionsPolicy {
  latencyHint: LatencyMode;
  sampleRate?: number;
  recreateOnSampleRateMismatch: boolean;
}

/** Rates worth requesting; anything else falls back to device native. */
export const SUPPORTED_SAMPLE_RATES = [
  44100, 48000, 88200, 96000, 176400, 192000,
] as const;

export const DEFAULT_AUDIO_CONTEXT_POLICY: AudioContextOptionsPolicy = {
  latencyHint: 'playback',
  recreateOnSampleRateMismatch: true,
};

export function resolveLatencyHint(userMode: LatencyMode): AudioContextLatencyCategory {
  return userMode;
}

/**
 * Pick a context sample rate to request. Returns undefined when the track rate
 * is missing or exotic so the browser can use the device native rate.
 */
export function chooseSampleRate(
  trackRate: number | undefined,
  _deviceRate?: number | undefined,
  supported: readonly number[] = SUPPORTED_SAMPLE_RATES,
): number | undefined {
  if (trackRate === undefined || trackRate <= 0) return undefined;
  if (!supported.includes(trackRate)) return undefined;
  return trackRate;
}

export function isSupportedSampleRate(
  rate: number,
  supported: readonly number[] = SUPPORTED_SAMPLE_RATES,
): boolean {
  return supported.includes(rate);
}

/**
 * Whether the live context should be rebuilt for a new track rate.
 * Compares against the context's actual rate so a rejected request does not
 * loop rebuilds on every subsequent track.
 */
export function shouldRecreateContext(
  currentRate: number,
  desiredRate: number | undefined,
  policy: Pick<AudioContextOptionsPolicy, 'recreateOnSampleRateMismatch'>,
  supported: readonly number[] = SUPPORTED_SAMPLE_RATES,
): boolean {
  if (!policy.recreateOnSampleRateMismatch) return false;
  const chosen = chooseSampleRate(desiredRate, undefined, supported);
  if (chosen === undefined) return false;
  return currentRate !== chosen;
}
