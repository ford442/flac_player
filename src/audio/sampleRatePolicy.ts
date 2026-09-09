/**
 * Shared AudioContext sample-rate and latency policy.
 *
 * Native file rate is preferred when the device can open it. Otherwise the
 * constructor omits `sampleRate` and the OS device default is used.
 */

export type LatencyMode = 'playback' | 'interactive' | 'balanced';

export type AudioContextLatencyHint = AudioContextLatencyCategory | number;

export interface AudioContextOptionsPolicy {
  latencyHint: AudioContextLatencyHint;
  /** Preferred constructor rate. Undefined = omit (device default / first-track native). */
  sampleRate?: number;
  recreateOnSampleRateMismatch: boolean;
}

export const DEFAULT_LATENCY_MODE: LatencyMode = 'playback';
export const BALANCED_LATENCY_SECONDS = 0.03;

export const DEFAULT_AUDIO_CONTEXT_POLICY: AudioContextOptionsPolicy = {
  latencyHint: 'playback',
  recreateOnSampleRateMismatch: true,
};

export function isLatencyMode(value: string | null | undefined): value is LatencyMode {
  return value === 'playback' || value === 'interactive' || value === 'balanced';
}

export function latencyModeToHint(mode: LatencyMode): AudioContextLatencyHint {
  if (mode === 'interactive') return 'interactive';
  if (mode === 'balanced') return BALANCED_LATENCY_SECONDS;
  return 'playback';
}

export function latencyHintsEqual(
  a: AudioContextLatencyHint,
  b: AudioContextLatencyHint
): boolean {
  return a === b;
}

export function chooseContextSampleRate(
  fileRate: number | undefined,
  isSupported: (rate: number) => boolean
): number | undefined {
  if (fileRate === undefined || !Number.isFinite(fileRate) || fileRate <= 0) {
    return undefined;
  }
  return isSupported(fileRate) ? fileRate : undefined;
}

export function shouldRecreateContext(options: {
  liveRate: number;
  targetRate: number | undefined;
  liveHint: AudioContextLatencyHint;
  nextHint: AudioContextLatencyHint;
  recreateOnMismatch: boolean;
}): boolean {
  if (!latencyHintsEqual(options.liveHint, options.nextHint)) return true;
  if (options.targetRate === undefined) return false;
  if (options.liveRate === options.targetRate) return false;
  return options.recreateOnMismatch;
}

type AudioContextCtor = typeof AudioContext & {
  isSampleRateSupported?: (sampleRate: number) => boolean;
};

/** Probe whether the constructor will accept `rate`. Closes any throwaway context. */
export function probeSampleRateSupported(rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const Ctor = globalThis.AudioContext as AudioContextCtor | undefined;
  if (!Ctor) return false;
  if (typeof Ctor.isSampleRateSupported === 'function') {
    try {
      return Ctor.isSampleRateSupported(rate);
    } catch {
      return false;
    }
  }
  try {
    const ctx = new Ctor({ sampleRate: rate });
    const ok = Math.abs(ctx.sampleRate - rate) < 1;
    void ctx.close();
    return ok;
  } catch {
    return false;
  }
}
