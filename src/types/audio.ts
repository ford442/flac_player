import type { PlaybackPathInfo } from '../utils/playbackPath';
import type { GaplessSettings, PreloadNextOptions, TrackTransitionEvent } from './gapless';

export interface AudioPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
  /** True while the next queue track is being fetched/decoded for gapless playback. */
  prebufferingNext?: boolean;
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
  setPlaybackRate(rate: number): void;
  setEQGains(gains: number[]): void;
  getAnalyser(): AnalyserNode | null;
  setOnEndedCallback(callback?: (event?: TrackTransitionEvent) => void): void;
  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void;
  getState(): AudioPlaybackState;
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
  loadFromURLStreaming?(
    url: string,
    options?: {
      expectedDuration?: number;
      cachedResponse?: Response;
      onProgress?: (loaded: number, total: number | null) => void;
    }
  ): Promise<void>;
}
