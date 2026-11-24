/** Public contract of the embeddable mini player (docs/EMBED.md). */

/** One playable item. Only `url` is required. */
export interface MiniTrack {
  /** Absolute http(s) URL (or a path relative to the host page). FLAC, WAV, MP3, … — whatever the browser's <audio> decodes. */
  url: string;
  /** Stable id; defaults to `url`. Reported back in events. */
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  /** Cover image URL (shown in the `card` layout). */
  artwork?: string;
  /** Known duration in seconds; used until the file's metadata loads. */
  duration?: number;
}

export type MiniEqPreset = 'flat' | 'bass' | 'vocal' | 'bright';

export type MiniPlayerLayout = 'bar' | 'card';

/** Imperative handle (`ref`) for host-page control. */
export interface MiniPlayerHandle {
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  /** Seconds, clamped to the track. */
  seek(seconds: number): void;
  next(): void;
  previous(): void;
  /** Jump to the track at `index` (keeps play state). */
  select(index: number): void;
  setVolume(volume: number): void;
  getState(): MiniPlayerState;
}

export interface MiniPlayerState {
  index: number;
  track: MiniTrack | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
}

export interface FlacMiniPlayerProps {
  /** A playlist. Ignored when `track` is set. */
  tracks?: MiniTrack[];
  /** Shorthand for a single-track player. */
  track?: MiniTrack;
  /** Uncontrolled start index (default 0). */
  initialIndex?: number;
  /** Controlled index: when set, the player follows it; pair with `onTrackChange`. */
  index?: number;
  /** Start playing once the first track can play (subject to browser autoplay policy). */
  autoPlay?: boolean;
  /** Wrap from the last track to the first. */
  loop?: boolean;
  /** `bar` (one row, default) or `card` (artwork + stacked controls). */
  layout?: MiniPlayerLayout;
  /** Show prev/next buttons (default: true when there is more than one track). */
  showNavigation?: boolean;
  /** Show the volume slider (default true; hidden on very narrow widths by CSS). */
  showVolume?: boolean;
  /** Initial volume 0..1 (default 1). */
  initialVolume?: number;
  /**
   * Fixed EQ preset (default `flat` — no Web Audio graph at all). Anything else routes the
   * <audio> element through a 5-band EQ; cross-origin files then need CORS headers.
   */
  eq?: MiniEqPreset;
  /** `<audio preload>` (default `metadata`). */
  preload?: 'none' | 'metadata' | 'auto';
  /** `auto` follows prefers-color-scheme (default); `light` / `dark` force one. */
  theme?: 'auto' | 'light' | 'dark';
  className?: string;
  /** Accessible name of the player region (default "Audio player"). */
  label?: string;

  onTrackChange?: (track: MiniTrack, index: number) => void;
  onPlay?: (track: MiniTrack, index: number) => void;
  onPause?: (track: MiniTrack, index: number) => void;
  /** A track finished (fires before auto-advancing). */
  onEnded?: (track: MiniTrack, index: number) => void;
  /** The last track finished and `loop` is off. */
  onQueueEnded?: () => void;
  /** ≈4 Hz while playing, and after seeks. */
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onError?: (error: Error, track: MiniTrack, index: number) => void;
}
