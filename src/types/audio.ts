export interface AudioPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
}

/** Stable contract shared by every selectable audio implementation. */
export interface AudioBackend {
  initialize(): Promise<void>;
  destroy(): void;
  loadFromArrayBuffer(buffer: ArrayBuffer, filename?: string): Promise<void>;
  loadFromURL?(url: string): Promise<void>;
  play(): void | Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  setEQGains(gains: number[]): void;
  getAnalyser(): AnalyserNode | null;
  setOnEndedCallback(callback?: () => void): void;
  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void;
  getState(): AudioPlaybackState;
}

/** Optional controls used by the streaming and Worklet implementations. */
export interface ConfigurableAudioBackend extends AudioBackend {
  setCrossfadeEnabled?(enabled: boolean): void;
  preloadNext?(url: string): void;
  setPCMCallback?(
    callback: ((buffer: Float32Array, channels: number, sampleRate: number) => void) | undefined
  ): void;
}
