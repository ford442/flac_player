import { vi } from 'vitest';
import { DEFAULT_AUDIO_BACKEND_CAPABILITIES, type AudioPlaybackState, type ConfigurableAudioBackend } from '../../src/types/audio';
import type { TrackTransitionEvent } from '../../src/types/gapless';
import type { PlaylistTrack } from '../../src/types/library';
import { PlaybackEngine, type EngineDeps } from '../../src/player/PlaybackEngine';
import { createPlayerStore } from '../../src/player/playerStore';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Backend double for engine tests. Loads resolve at once unless `holdLoads` is
 * set; then each `loadFromURL` waits for `releaseLoad(url)`.
 */
export class FakeBackend {
  static created: FakeBackend[] = [];
  state: AudioPlaybackState = { isPlaying: false, currentTime: 0, duration: 0, isLoading: false };
  loadedUrl: string | null = null;
  holdLoads = false;
  readonly pending = new Map<string, Deferred>();
  private onState?: (state: AudioPlaybackState) => void;
  private onEnded?: (event?: TrackTransitionEvent) => void;

  initialize = vi.fn(async () => {});
  destroy = vi.fn();
  loadFromURL = vi.fn(async (url: string) => {
    if (this.holdLoads) {
      const d = deferred();
      this.pending.set(url, d);
      await d.promise;
    }
    this.loadedUrl = url;
    this.state = { isPlaying: false, currentTime: 0, duration: 100, isLoading: false };
  });
  loadFromArrayBuffer = vi.fn(async () => {
    this.state = { isPlaying: false, currentTime: 0, duration: 100, isLoading: false };
  });
  play = vi.fn(async () => { this.state = { ...this.state, isPlaying: true }; this.emit(); });
  pause = vi.fn(() => { this.state = { ...this.state, isPlaying: false }; this.emit(); });
  stop = vi.fn(() => { this.state = { ...this.state, isPlaying: false, currentTime: 0 }; this.emit(); });
  seek = vi.fn((t: number) => { this.state = { ...this.state, currentTime: t }; this.emit(); });
  setVolume = vi.fn();
  setPlaybackRate = vi.fn();
  setEQGains = vi.fn();
  setGaplessSettings = vi.fn();
  setNativeOnly = vi.fn();
  preloadNext = vi.fn();
  clearPreload = vi.fn();
  setReplayGainLinear = vi.fn();
  setReplayGainLimiter = vi.fn();

  constructor(readonly mode: string) { FakeBackend.created.push(this); }

  setStateChangeCallback(cb: (state: AudioPlaybackState) => void): void { this.onState = cb; }
  setOnEndedCallback(cb?: (event?: TrackTransitionEvent) => void): void { this.onEnded = cb; }
  getState(): AudioPlaybackState { return { ...this.state }; }
  getCapabilities() { return DEFAULT_AUDIO_BACKEND_CAPABILITIES; }
  getAnalyser() { return null; }
  getPlaybackPath() { return null; }

  emit(): void { this.onState?.(this.getState()); }
  /** Report progress the way timeupdate / worklet position messages do. */
  report(patch: Partial<AudioPlaybackState>): void { this.state = { ...this.state, ...patch }; this.emit(); }
  end(event?: TrackTransitionEvent): void {
    this.state = { ...this.state, isPlaying: false };
    this.emit();
    this.onEnded?.(event);
  }
  releaseLoad(url: string): void { this.pending.get(url)?.resolve(); }
}

export const track = (id: string, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  id, source: 'library', name: id, title: id, url: `https://storage.test/${id}.flac`, duration: 100, ...overrides,
});

export function makeEngine(overrides: Partial<EngineDeps> = {}) {
  FakeBackend.created.length = 0;
  const store = createPlayerStore();
  let now = 0;
  const graphListeners = new Set<() => void>();
  const deps: EngineDeps = {
    createBackend: vi.fn(async (mode: string) => new FakeBackend(mode) as unknown as ConfigurableAudioBackend),
    subscribeGraphRecreated: (listener) => { graphListeners.add(listener); return () => { graphListeners.delete(listener); }; },
    candidateUrls: (url) => [url],
    fetchTrackBytes: async () => new ArrayBuffer(8),
    probeContentLength: async () => 1000,
    recordPlay: vi.fn(),
    enrichReplayGain: async (t) => t,
    readLocalFile: async (file) => ({ id: `local-${file.name}`, source: 'local', file, name: file.name, url: 'blob:x' }),
    readSavedPosition: () => null,
    attachVisualizerFeed: () => () => {},
    onTrackChange: () => {},
    now: () => now,
    ...overrides,
  };
  const engine = new PlaybackEngine(store, deps);
  const detach = engine.attach();
  return {
    engine,
    store,
    deps,
    detach,
    /** Advance the engine's monotonic clock (ms). */
    advance: (ms: number) => { now += ms; },
    recreateGraph: () => graphListeners.forEach((listener) => listener()),
    backend: () => FakeBackend.created.at(-1)!,
    /** Let queued promise callbacks run. */
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}
