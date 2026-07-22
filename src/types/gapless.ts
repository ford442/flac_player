/** Queue transition mode between tracks. */
export type GaplessMode = 'off' | 'gapless' | 'crossfade';

export const DEFAULT_GAPLESS_MODE: GaplessMode = 'gapless';
export const DEFAULT_CROSSFADE_MS = 3000;
export const MIN_CROSSFADE_MS = 0;
export const MAX_CROSSFADE_MS = 12000;
export const PRELOAD_AHEAD_S = 8;

export interface GaplessSettings {
  mode: GaplessMode;
  crossfadeMs: number;
}

export interface PreloadNextOptions {
  url: string;
  /** Library metadata duration (seconds); header parse refines this when available. */
  duration?: number;
}

export interface TrackTransitionEvent {
  /** Next track is already playing — UI should advance index without reloading. */
  alreadyPlayingNext: boolean;
}

export function overlapSeconds(settings: GaplessSettings): number {
  if (settings.mode !== 'crossfade') return 0;
  return Math.max(0, settings.crossfadeMs) / 1000;
}

export function isGaplessActive(settings: GaplessSettings): boolean {
  return settings.mode === 'gapless' || settings.mode === 'crossfade';
}
