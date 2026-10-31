/**
 * Shared AudioContext sample-rate and latency policy.
 *
 * Default: one context at the output device's rate for the page's lifetime.
 * Browsers resample a context to the device anyway, so a context opened at the
 * file's rate is only bit-exact when the device already runs at that rate, and
 * then the device-rate context is too (decision record: docs/AUDIO_BACKENDS.md,
 * "One context at the device rate"). `recreateOnSampleRateMismatch` (or
 * `?ctxrate=native`) restores the old open-at-file-rate behavior.
 */

export type LatencyMode = 'playback' | 'interactive' | 'balanced';

export type AudioContextLatencyHint = AudioContextLatencyCategory | number;

/**
 * Render quantum hint (Chromium `AudioContextOptions.renderSizeHint`).
 * 'default' omits the option (128-frame quantum).
 */
export type RenderSizeMode = 'default' | 'hardware' | '256' | '512';

export type RenderSizeHint = 'default' | 'hardware' | number;

export interface AudioContextOptionsPolicy {
  latencyHint: AudioContextLatencyHint;
  /** Undefined = omit from the constructor. */
  renderSizeHint?: RenderSizeHint;
  /** Preferred constructor rate. Undefined = omit (device default / first-track native). */
  sampleRate?: number;
  recreateOnSampleRateMismatch: boolean;
}

export const DEFAULT_LATENCY_MODE: LatencyMode = 'playback';
export const BALANCED_LATENCY_SECONDS = 0.03;

export const DEFAULT_AUDIO_CONTEXT_POLICY: AudioContextOptionsPolicy = {
  latencyHint: 'playback',
  recreateOnSampleRateMismatch: false,
};

/** `?ctxrate=native`: open (and rebuild) the context at each file's rate, for A/B. */
export function isNativeRateRequestedByUrl(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('ctxrate') === 'native';
  } catch {
    return false;
  }
}

export function isLatencyMode(value: string | null | undefined): value is LatencyMode {
  return value === 'playback' || value === 'interactive' || value === 'balanced';
}

export function latencyModeToHint(mode: LatencyMode): AudioContextLatencyHint {
  if (mode === 'interactive') return 'interactive';
  if (mode === 'balanced') return BALANCED_LATENCY_SECONDS;
  return 'playback';
}

export const DEFAULT_RENDER_SIZE_MODE: RenderSizeMode = 'default';

export function isRenderSizeMode(value: string | null | undefined): value is RenderSizeMode {
  return value === 'default' || value === 'hardware' || value === '256' || value === '512';
}

export function renderSizeModeToHint(mode: RenderSizeMode): RenderSizeHint | undefined {
  if (mode === 'hardware') return 'hardware';
  if (mode === '256') return 256;
  if (mode === '512') return 512;
  return undefined;
}

/** True when the browser exposes `AudioContext.renderQuantumSize` (and so reads renderSizeHint). */
export function isRenderSizeHintSupported(): boolean {
  const Ctor = globalThis.AudioContext as { prototype?: object } | undefined;
  return !!Ctor?.prototype && 'renderQuantumSize' in Ctor.prototype;
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
  liveRenderSize?: RenderSizeHint;
  nextRenderSize?: RenderSizeHint;
}): boolean {
  if (!latencyHintsEqual(options.liveHint, options.nextHint)) return true;
  if (options.liveRenderSize !== options.nextRenderSize) return true;
  if (options.targetRate === undefined) return false;
  if (options.liveRate === options.targetRate) return false;
  return options.recreateOnMismatch;
}

type AudioContextCtor = typeof AudioContext & {
  isSampleRateSupported?: (sampleRate: number) => boolean;
};

/**
 * Whether to ask the constructor for `rate`. Uses `AudioContext.isSampleRateSupported`
 * where it exists and otherwise assumes yes: a rejected rate is caught by the
 * constructor relaxation ({@link relaxContextOptions}) and remembered there, so no
 * throwaway context is ever opened just to test a rate.
 */
export function isSampleRateAccepted(rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const Ctor = globalThis.AudioContext as AudioContextCtor | undefined;
  if (!Ctor) return false;
  if (typeof Ctor.isSampleRateSupported !== 'function') return true;
  try {
    return Ctor.isSampleRateSupported(rate);
  } catch {
    return false;
  }
}

/** `AudioContextOptions` plus `sinkId` / `renderSizeHint` (Chromium; not yet in lib.dom). */
export interface AudioContextOptionsWithSink extends AudioContextOptions {
  /** A device id, or `{ type: 'none' }` to render without an output device. */
  sinkId?: string | { type: 'none' };
  renderSizeHint?: RenderSizeHint;
}

/**
 * Next, less demanding constructor options after `new AudioContext(options)` threw.
 * Order: numeric latencyHint → 'interactive', then drop sinkId, then drop
 * renderSizeHint, then drop sampleRate (native rate is the last thing given up).
 * Returns null when nothing is left to relax (caller rethrows).
 */
export function relaxContextOptions(
  options: AudioContextOptionsWithSink
): AudioContextOptionsWithSink | null {
  if (typeof options.latencyHint === 'number') {
    return { ...options, latencyHint: 'interactive' };
  }
  if (options.sinkId !== undefined) {
    const rest = { ...options };
    delete rest.sinkId;
    return rest;
  }
  if (options.renderSizeHint !== undefined) {
    const rest = { ...options };
    delete rest.renderSizeHint;
    return rest;
  }
  if (options.sampleRate !== undefined) {
    const rest = { ...options };
    delete rest.sampleRate;
    return rest;
  }
  return null;
}

/**
 * Destination channel count for a track. Never below stereo (mono files are
 * upmixed by the graph, not by collapsing the device), never above the device.
 */
export function destinationChannelCount(
  trackChannels: number | undefined,
  maxChannelCount: number | undefined
): number | undefined {
  if (!trackChannels || !Number.isFinite(trackChannels) || trackChannels <= 0) return undefined;
  const wanted = Math.max(2, Math.floor(trackChannels));
  if (!maxChannelCount || maxChannelCount <= 0) return wanted;
  return Math.max(1, Math.min(wanted, maxChannelCount));
}
