import type { PlaybackPathInfo } from '../utils/playbackPath';
import type { GaplessSettings, PreloadNextOptions, TrackTransitionEvent } from './gapless';

/** Selectable playback engine (`createAudioBackend`). */
export type AudioOutputMode = 'streaming' | 'web-audio' | 'worklet' | 'sdl';

export interface AudioPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
  /** True while the next queue track is being fetched/decoded for gapless playback. */
  prebufferingNext?: boolean;
}

/** Zero-copy view of decoded PCM for display chores (not the audio callback). */
export interface DecodedPcmView {
  pcm: Float32Array;
  channels: number;
  sampleRate: number;
}

/**
 * What the live backend can honor right now. May change per track (e.g. the
 * streaming facade on its hi-fi path cannot seek). UI reads this instead of
 * inferring from output mode or playback path.
 */
export interface AudioBackendCapabilities {
  /**
   * False when this backend cannot make sound in this browser: the worklet
   * backends need AudioWorklet, and `sdl` also needs cross-origin isolation
   * (SharedArrayBuffer). Loads then reject; nothing falls back to a
   * main-thread ScriptProcessor.
   */
  playable: boolean;
  seek: boolean;
  playbackRate: boolean;
  /**
   * The speed control can keep the original pitch: the dsp-chain worklet's
   * pitch-hold stage (src/sdl/dsp_stretch.h) for graph sources, `<audio>`
   * preservesPitch for the native streaming path. False when only varispeed is
   * possible (the Web Audio DSP fallback, or a format above the stretch cap).
   */
  pitchHold: boolean;
  gapless: boolean;
  crossfade: boolean;
  /** Output device selection (AudioContext.setSinkId). */
  sinkId: boolean;
}

/** Permissive default for callers that have no backend yet. */
export const DEFAULT_AUDIO_BACKEND_CAPABILITIES: AudioBackendCapabilities = {
  playable: true,
  seek: true,
  playbackRate: true,
  pitchHold: true,
  gapless: true,
  crossfade: true,
  sinkId: false,
};

/**
 * Playback clock for listening rooms (#209). Same semantics as
 * HTMLMediaElement.currentTime; only the native `<audio>` streaming path
 * provides one in the MVP.
 */
export interface SyncClock {
  /** Seconds into the current track. */
  getSyncPosition(): number;
  isSyncPlaying(): boolean;
  /** True once the current track played to its end. */
  isSyncEnded(): boolean;
  /** True while seeking or buffering, when the position is not advancing reliably. */
  isSyncSeeking(): boolean;
  getSyncRate(): number;
}

/** Stable contract shared by every selectable audio implementation. */
export interface AudioBackend {
  initialize(): Promise<void>;
  destroy(): void;
  loadFromArrayBuffer(buffer: ArrayBuffer, filename?: string): Promise<void>;
  loadFromURL?(url: string, options?: { expectedDuration?: number }): Promise<void>;
  play(): void | Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  /**
   * Tempo `rate` (0.25–4). `preservePitch` (default true) keeps the original
   * pitch — time ratio 1/rate at pitch ratio 1; false is varispeed (tempo and
   * pitch move together, the frequency-ratio behaviour). Where pitch hold is
   * unavailable (capabilities.pitchHold false) the rate is varispeed regardless.
   */
  setPlaybackRate(rate: number, preservePitch?: boolean): void;
  setEQGains(gains: number[]): void;
  /** Apply ReplayGain loudness offset as a linear gain multiplier. */
  setReplayGainLinear?(linear: number): void;
  setReplayGainLimiter?(enabled: boolean): void;
  getAnalyser(): AnalyserNode | null;
  setOnEndedCallback(callback?: (event?: TrackTransitionEvent) => void): void;
  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void;
  getState(): AudioPlaybackState;
  getCapabilities(): AudioBackendCapabilities;
}

/** Optional controls used by the streaming and Worklet implementations. */
export interface ConfigurableAudioBackend extends AudioBackend {
  setGaplessSettings?(settings: GaplessSettings): void;
  /** @deprecated Use setGaplessSettings */
  setCrossfadeEnabled?(enabled: boolean): void;
  preloadNext?(options: PreloadNextOptions | string): void;
  clearPreload?(): void;
  setPCMCallback?(
    callback: ((buffer: Float32Array, channels: number, sampleRate: number) => void) | undefined
  ): void;
  getPlaybackPath?(): PlaybackPathInfo | null;
  /**
   * Full-file decoded PCM for display chores (scrubber peaks / RMS).
   * Streaming/native paths return null — no second decode.
   */
  getDecodedPcm?(): DecodedPcmView | null;
  /** Room sync clock; null when the active path cannot provide one (rooms need streaming). */
  getSyncClock?(): SyncClock | null;
  /** Force the native `<audio>` path on subsequent loads (listening rooms). */
  setNativeOnly?(enabled: boolean): void;
  loadFromURLStreaming?(
    url: string,
    options?: {
      expectedDuration?: number;
      cachedResponse?: Response;
      onProgress?: (loaded: number, total: number | null) => void;
    }
  ): Promise<void>;
  /**
   * A local file on the same graph as remote tracks (#284): FLAC through the hi-fi stream
   * session (range reads from the Blob, so seek never reads the whole file), other
   * formats decoded whole. Backends without it get `loadFromArrayBuffer`.
   */
  loadFromBlob?(blob: Blob, options: BlobLoadOptions): Promise<void>;
}

export interface BlobLoadOptions {
  /** The track's `url`: identity for gapless preload; never fetched. */
  key: string;
  /** File name, for format detection and decode errors. */
  name: string;
  expectedDuration?: number;
}
