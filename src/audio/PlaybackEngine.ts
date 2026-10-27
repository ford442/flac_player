// PlaybackEngine — the one transport behind every backend.
//
//   UI (Player, ShaderGUI, Media Session, room bridge)
//        │  commands: load / play / pause / seek / stop
//        ▼
//   PlaybackEngine   ← one currentTime, fed by the backend state callback
//        ├─ StreamingAudioPlayer | WebAudio | Worklet | SDL engine
//        └─ AudioContextManager (shared graph; the engine never suspends it)
//
// React reads it as an external store (`useSyncExternalStore`): `getStatus()`
// is a stable snapshot that only changes on discrete transport changes, and
// `getTime()` is the clock. Components that do not show time never re-render
// on `timeupdate`. Queue policy stays in the hook; gapless policy stays in
// types/gapless.ts — the engine only forwards `preloadNext`.

import type { AudioOutputMode } from '../hooks/usePlayerState';
import {
  DEFAULT_AUDIO_BACKEND_CAPABILITIES,
  type AudioBackendCapabilities,
  type AudioPlaybackState,
  type ConfigurableAudioBackend,
  type DecodedPcmView,
  type SyncClock,
} from '../types/audio';
import { isGaplessActive, type GaplessSettings, type TrackTransitionEvent } from '../types/gapless';
import type { AudioLoader } from '../audioLoader';
import { selectDecodeStrategy, type PlaybackPathInfo } from '../utils/playbackPath';
import { getPreferredStorageUrls } from '../utils/audioUtils';
import { getOrFetchTrack } from '../storage/trackCache';
import { createProjectMPCMFeed } from '../utils/projectMBridge';
import { createSerialQueue, type SerialQueue } from '../utils/serialQueue';
import { AudioContextManager, sharedAudioContextManager } from './AudioContextManager';
import { createAudioBackend } from './createAudioBackend';
import { POSITION_SAVE_INTERVAL_MS, writeSavedPosition } from './playbackPosition';

export interface PlaybackStatus {
  isPlaying: boolean;
  isLoading: boolean;
  duration: number;
  /** Next queue track is being fetched/decoded for gapless playback. */
  prebufferingNext: boolean;
  playbackPath: PlaybackPathInfo | null;
  /** What the live backend honors for the loaded track (seek / gapless / rate). */
  capabilities: AudioBackendCapabilities;
  /** Bumps when the backend instance or the shared audio graph is replaced. */
  backendGeneration: number;
}

export interface EngineTrack {
  url: string;
  /** Library duration (seconds); backends refine it from the file. */
  duration?: number;
  /** From positionKeyForTrack(); null/absent disables resume saves. */
  positionKey?: string | null;
}

export interface EngineLoadOptions {
  /** Start once loaded (default true). play()/pause() during the load override it. */
  autoplay?: boolean;
  /** Seek here (seconds) before playback starts. */
  startAt?: number;
}

/** `superseded`: a newer load, stop, or backend swap won; nothing was started. */
export type LoadOutcome = 'loaded' | 'superseded';

type EngineLoader = Pick<AudioLoader, 'probeAudioUrl' | 'loadFromURL'>;

export interface PlaybackEngineOptions {
  loader: EngineLoader;
  contextManager?: AudioContextManager;
  createBackend?: (mode: AudioOutputMode, manager: AudioContextManager) => Promise<ConfigurableAudioBackend>;
  /** Per-backend side channel (projectM PCM feed); returns its teardown. */
  attachBackend?: (backend: ConfigurableAudioBackend) => () => void;
}

const INITIAL_STATUS: PlaybackStatus = {
  isPlaying: false,
  isLoading: false,
  duration: 0,
  prebufferingNext: false,
  playbackPath: null,
  capabilities: DEFAULT_AUDIO_BACKEND_CAPABILITIES,
  backendGeneration: 0,
};

function shallowEqual<T extends object>(a: T | null, b: T | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export class PlaybackEngine {
  private readonly loader: EngineLoader;
  private readonly contextManager: AudioContextManager;
  private readonly createBackend: NonNullable<PlaybackEngineOptions['createBackend']>;
  private readonly attachBackend: NonNullable<PlaybackEngineOptions['attachBackend']>;

  private readonly listeners = new Set<() => void>();
  private status: PlaybackStatus = INITIAL_STATUS;
  private time = 0;

  private mode: AudioOutputMode | null = null;
  private backend: ConfigurableAudioBackend | null = null;
  private backendReady: Promise<ConfigurableAudioBackend | null> = Promise.resolve(null);
  private backendToken = 0;
  private detachBackend: (() => void) | null = null;
  /** Backend load calls run one at a time; reset per backend instance. */
  private backendLoads: SerialQueue = createSerialQueue();

  private loadGeneration = 0;
  private loadInFlight: Promise<LoadOutcome> | null = null;
  private pendingAutoplay = false;
  private playInFlight: Promise<void> | null = null;

  private current: EngineTrack | null = null;
  private next: EngineTrack | null = null;

  private volume = 1;
  private eqGains: number[] | null = null;
  private playbackRate = 1;
  private gaplessSettings: GaplessSettings | null = null;
  private replayGainLinear = 1;
  private replayGainLimiter = false;
  private nativeOnly = false;

  private persistPositions = true;
  private lastPositionSave = 0;

  private onEnded: ((event?: TrackTransitionEvent) => void) | undefined;
  private onError: ((message: string) => void) | undefined;
  private unsubscribeGraph: (() => void) | null = null;
  private destroyed = false;

  constructor(options: PlaybackEngineOptions) {
    this.loader = options.loader;
    this.contextManager = options.contextManager ?? sharedAudioContextManager;
    this.createBackend = options.createBackend ?? createAudioBackend;
    this.attachBackend = options.attachBackend ?? createProjectMPCMFeed;
  }

  private onGraphRecreated = (): void => {
    // Analyser and nodes were rebuilt. Backends handle the recreate in their own
    // listeners (the streaming facade drops its native next element), so
    // re-arm the preload after all of them ran.
    this.patchStatus({ backendGeneration: this.status.backendGeneration + 1 });
    this.emit();
    queueMicrotask(() => this.applyNext());
  };

  // ---------------------------------------------------------------------------
  // External store
  // ---------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getStatus = (): PlaybackStatus => this.status;

  readonly getTime = (): number => this.time;

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Replace the status snapshot only when a field actually changed. */
  private patchStatus(patch: Partial<PlaybackStatus>): void {
    const nextStatus = { ...this.status, ...patch };
    if (patch.capabilities && shallowEqual(patch.capabilities, this.status.capabilities)) {
      nextStatus.capabilities = this.status.capabilities;
    }
    if (patch.playbackPath !== undefined && shallowEqual(patch.playbackPath, this.status.playbackPath)) {
      nextStatus.playbackPath = this.status.playbackPath;
    }
    if (!shallowEqual(nextStatus, this.status)) this.status = nextStatus;
  }

  // ---------------------------------------------------------------------------
  // Backend lifecycle
  // ---------------------------------------------------------------------------

  getOutputMode(): AudioOutputMode | null {
    return this.mode;
  }

  /** Live backend, or null while one is being created. Changes with backendGeneration. */
  getBackend(): ConfigurableAudioBackend | null {
    return this.backend;
  }

  /** Create the backend for `mode` (replacing the old one). Resolves once initialized. */
  setOutputMode(mode: AudioOutputMode): Promise<ConfigurableAudioBackend | null> {
    if (mode === this.mode) return this.backendReady;
    this.mode = mode;
    this.unsubscribeGraph ??= this.contextManager.subscribeGraphRecreated(this.onGraphRecreated);
    const token = ++this.backendToken;
    this.cancelLoad();
    this.teardownBackend();
    this.time = 0;
    this.patchStatus({
      isPlaying: false,
      isLoading: false,
      duration: 0,
      prebufferingNext: false,
      playbackPath: null,
      capabilities: DEFAULT_AUDIO_BACKEND_CAPABILITIES,
    });
    this.emit();

    this.backendReady = this.createBackend(mode, this.contextManager).then(async (backend) => {
      if (token !== this.backendToken || this.destroyed) {
        backend.destroy();
        return null;
      }
      this.adoptBackend(backend);
      try {
        await backend.initialize();
      } catch (err) {
        if (token === this.backendToken) {
          this.reportError(err instanceof Error ? err.message : `${mode} initialization failed`);
        }
      }
      return token === this.backendToken ? backend : null;
    }, (err: unknown) => {
      if (token === this.backendToken) {
        this.reportError(err instanceof Error ? err.message : `${mode} initialization failed`);
      }
      return null;
    });
    return this.backendReady;
  }

  private adoptBackend(backend: ConfigurableAudioBackend): void {
    this.backend = backend;
    this.backendLoads = createSerialQueue();
    backend.setStateChangeCallback((state) => this.onBackendState(backend, state));
    backend.setOnEndedCallback((event) => this.onBackendEnded(backend, event));
    backend.setVolume(this.volume);
    if (this.eqGains) backend.setEQGains(this.eqGains);
    backend.setPlaybackRate(this.playbackRate);
    if (this.gaplessSettings) backend.setGaplessSettings?.(this.gaplessSettings);
    backend.setReplayGainLinear?.(this.replayGainLinear);
    backend.setReplayGainLimiter?.(this.replayGainLimiter);
    backend.setNativeOnly?.(this.nativeOnly);
    this.detachBackend = this.attachBackend(backend);
    this.patchStatus({
      capabilities: backend.getCapabilities(),
      backendGeneration: this.status.backendGeneration + 1,
    });
    this.emit();
  }

  private teardownBackend(): void {
    const backend = this.backend;
    this.backend = null;
    this.current = null;
    this.playInFlight = null;
    this.detachBackend?.();
    this.detachBackend = null;
    if (!backend) return;
    backend.setOnEndedCallback(undefined);
    backend.destroy();
  }

  private onBackendState(backend: ConfigurableAudioBackend, state: AudioPlaybackState): void {
    if (backend !== this.backend) return;
    const wasPlaying = this.status.isPlaying;
    this.time = state.currentTime;
    this.patchStatus({
      isPlaying: state.isPlaying,
      duration: state.duration,
      prebufferingNext: Boolean(state.prebufferingNext),
    });
    this.savePosition(wasPlaying && !state.isPlaying);
    this.emit();
  }

  private onBackendEnded(backend: ConfigurableAudioBackend, event?: TrackTransitionEvent): void {
    if (backend !== this.backend) return;
    if (event?.alreadyPlayingNext) {
      // Gapless / crossfade handoff: the preloaded track is now current.
      this.current = this.next;
      this.next = null;
      this.lastPositionSave = 0;
      this.refreshTrackStatus(backend);
      this.emit();
    }
    this.onEnded?.(event);
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * The one load path. Cancels any in-flight load (generation counter), stops
   * the path being left, then starts the new one. Every await re-checks the
   * generation, so a stale load never touches the backend again.
   */
  load(track: EngineTrack, options: EngineLoadOptions = {}): Promise<LoadOutcome> {
    const gen = this.beginLoad(options.autoplay ?? true);
    const run = this.runLoad(gen, track, options.startAt);
    this.loadInFlight = run;
    return run.finally(() => {
      if (this.loadInFlight === run) this.loadInFlight = null;
    });
  }

  /** Local file bytes (buffered backends only). */
  loadFile(buffer: ArrayBuffer, filename: string, track: EngineTrack, options: EngineLoadOptions = {}): Promise<LoadOutcome> {
    const gen = this.beginLoad(options.autoplay ?? true);
    const run = this.runLoad(gen, track, options.startAt, async (backend) => {
      await this.backendLoads(async () => {
        if (this.isStale(gen)) return;
        await backend.loadFromArrayBuffer(buffer, filename);
      });
    });
    this.loadInFlight = run;
    return run.finally(() => {
      if (this.loadInFlight === run) this.loadInFlight = null;
    });
  }

  private beginLoad(autoplay: boolean): number {
    const gen = ++this.loadGeneration;
    this.pendingAutoplay = autoplay;
    this.playInFlight = null;
    this.savePosition(true);
    this.backend?.stop();
    this.time = 0;
    this.patchStatus({ isLoading: true, isPlaying: false });
    this.emit();
    return gen;
  }

  private isStale(gen: number): boolean {
    return gen !== this.loadGeneration || this.destroyed;
  }

  private async runLoad(
    gen: number,
    track: EngineTrack,
    startAt: number | undefined,
    loadInto: (backend: ConfigurableAudioBackend) => Promise<void> = (backend) => this.loadUrlInto(gen, backend, track),
  ): Promise<LoadOutcome> {
    try {
      const backend = await this.backendReady;
      if (this.isStale(gen)) return 'superseded';
      if (!backend) throw new Error('Audio backend is not available');
      // Fail closed before fetching anything: there is no main-thread fallback.
      if (!backend.getCapabilities().playable) {
        throw new Error(`The ${this.mode ?? 'selected'} output cannot play in this browser; switch to Streaming`);
      }
      // A previous load may have started something after beginLoad's stop().
      backend.stop();

      try {
        await loadInto(backend);
      } catch (err) {
        if (this.isStale(gen)) return 'superseded';
        throw err;
      }
      if (this.isStale(gen) || backend !== this.backend) return 'superseded';

      this.current = track;
      this.lastPositionSave = 0;
      if (startAt !== undefined && startAt > 0) backend.seek(startAt);
      this.refreshTrackStatus(backend);
      this.applyNext();

      if (this.pendingAutoplay) {
        await this.playBackend(backend);
      } else if (backend.getState().isPlaying) {
        // Hi-fi streams start on load; honor autoplay:false (room guests).
        backend.pause();
      }
      if (this.isStale(gen)) return 'superseded';
      return 'loaded';
    } finally {
      if (!this.isStale(gen)) {
        this.patchStatus({ isLoading: false });
        this.emit();
      }
    }
  }

  /** URL candidates × decode strategy for the active output mode. */
  private async loadUrlInto(gen: number, backend: ConfigurableAudioBackend, track: EngineTrack): Promise<void> {
    const expectedDuration = track.duration && track.duration > 0 ? track.duration : undefined;
    const candidateUrls = getPreferredStorageUrls(track.url);
    let lastError: unknown;

    for (const url of candidateUrls) {
      try {
        if (this.mode === 'streaming' && backend.loadFromURL) {
          // The streaming facade supersedes its own earlier loads.
          await backend.loadFromURL(url, { expectedDuration });
          return;
        }
        if ((this.mode === 'worklet' || this.mode === 'sdl') && backend.loadFromURLStreaming) {
          const probe = await this.loader.probeAudioUrl(url);
          if (this.isStale(gen)) return;
          const strategy = selectDecodeStrategy(probe.contentLength, { outputMode: this.mode, url });
          if (strategy === 'hifi-stream') {
            await this.backendLoads(async () => {
              if (this.isStale(gen)) return;
              await backend.loadFromURLStreaming!(url, { expectedDuration });
            });
            return;
          }
        }
        const buffer = await this.fetchTrackBytes(url);
        await this.backendLoads(async () => {
          if (this.isStale(gen)) return;
          await backend.loadFromArrayBuffer(buffer);
        });
        return;
      } catch (err) {
        if (this.isStale(gen) || isAbortError(err)) throw err;
        lastError = err;
      }
    }

    const msg = `Failed to load audio from any source: ${candidateUrls.join(', ')}`;
    throw new Error(lastError instanceof Error && lastError.message ? `${msg} (${lastError.message})` : msg);
  }

  private async fetchTrackBytes(url: string): Promise<ArrayBuffer> {
    try {
      const response = await getOrFetchTrack(url);
      return await response.arrayBuffer();
    } catch (cacheErr) {
      console.warn('Offline cache miss or error, falling back to network fetch:', cacheErr);
      return this.loader.loadFromURL(url);
    }
  }

  private cancelLoad(): void {
    this.loadGeneration++;
    this.pendingAutoplay = false;
    if (this.status.isLoading) this.patchStatus({ isLoading: false });
  }

  private refreshTrackStatus(backend: ConfigurableAudioBackend): void {
    const state = backend.getState();
    this.time = state.currentTime;
    this.patchStatus({
      isPlaying: state.isPlaying,
      duration: state.duration,
      prebufferingNext: Boolean(state.prebufferingNext),
      playbackPath: backend.getPlaybackPath?.() ?? null,
      capabilities: backend.getCapabilities(),
    });
  }

  // ---------------------------------------------------------------------------
  // Transport commands
  // ---------------------------------------------------------------------------

  /**
   * Start playback. During a load this only arms autoplay for that load's
   * generation, so overlapping play() calls (click, Media Session, room) start
   * the track once. Concurrent calls share one backend play().
   */
  play(): Promise<void> {
    const inFlight = this.loadInFlight;
    if (inFlight) {
      this.pendingAutoplay = true;
      // Armed after the load checked autoplay: start it once the load settles.
      return inFlight.then((outcome) => {
        if (outcome === 'loaded' && this.pendingAutoplay && !this.status.isPlaying) return this.play();
        return undefined;
      }, () => undefined);
    }
    const backend = this.backend;
    if (!backend) return Promise.resolve();
    return this.playBackend(backend);
  }

  private playBackend(backend: ConfigurableAudioBackend): Promise<void> {
    if (this.playInFlight) return this.playInFlight;
    const run = Promise.resolve(backend.play()).catch((err: unknown) => {
      // play() interrupted by pause() / a newer load is not a failure.
      if (!isAbortError(err)) throw err;
    }).finally(() => {
      if (this.playInFlight === run) this.playInFlight = null;
    });
    this.playInFlight = run;
    return run;
  }

  pause(): void {
    this.pendingAutoplay = false;
    this.playInFlight = null;
    this.backend?.pause();
  }

  /** Stop and rewind; also cancels an in-flight load. */
  stop(): void {
    this.cancelLoad();
    this.playInFlight = null;
    this.backend?.stop();
    this.emit();
  }

  seek(seconds: number): void {
    const backend = this.backend;
    if (!backend) return;
    backend.seek(seconds);
    this.time = backend.getState().currentTime;
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Settings (remembered and re-applied to each new backend)
  // ---------------------------------------------------------------------------

  setVolume(volume: number): void {
    this.volume = volume;
    this.backend?.setVolume(volume);
  }

  setEQGains(gains: number[]): void {
    this.eqGains = gains;
    this.backend?.setEQGains(gains);
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    this.backend?.setPlaybackRate(rate);
  }

  setGaplessSettings(settings: GaplessSettings): void {
    this.gaplessSettings = settings;
    this.backend?.setGaplessSettings?.(settings);
    this.applyNext();
  }

  setReplayGainLinear(linear: number): void {
    this.replayGainLinear = linear;
    this.backend?.setReplayGainLinear?.(linear);
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.replayGainLimiter = enabled;
    this.backend?.setReplayGainLimiter?.(enabled);
  }

  /** Force the native `<audio>` path on later loads (listening rooms). */
  setNativeOnly(enabled: boolean): void {
    this.nativeOnly = enabled;
    this.backend?.setNativeOnly?.(enabled);
  }

  /** Gapless successor; null clears the preload. */
  setNext(next: EngineTrack | null): void {
    if (shallowEqual(next, this.next)) return;
    this.next = next;
    this.applyNext();
  }

  private applyNext(): void {
    const backend = this.backend;
    if (!backend || this.loadInFlight) return;
    const next = this.next;
    if (!next || !this.gaplessSettings || !isGaplessActive(this.gaplessSettings)) {
      backend.clearPreload?.();
      return;
    }
    backend.preloadNext?.({ url: next.url, duration: next.duration });
  }

  setPositionPersistence(enabled: boolean): void {
    this.persistPositions = enabled;
  }

  /** Throttled resume save; `force` writes now (pause, track change). */
  private savePosition(force: boolean): void {
    const key = this.current?.positionKey;
    if (!this.persistPositions || !key) return;
    const time = this.time;
    const duration = this.status.duration;
    if (!(time > 0) || !(duration > 0) || duration - time < 1) return;
    const now = Date.now();
    if (!force && now - this.lastPositionSave < POSITION_SAVE_INTERVAL_MS) return;
    this.lastPositionSave = now;
    writeSavedPosition(key, time);
  }

  setOnEnded(callback: ((event?: TrackTransitionEvent) => void) | undefined): void {
    this.onEnded = callback;
  }

  setOnError(callback: ((message: string) => void) | undefined): void {
    this.onError = callback;
  }

  private reportError(message: string): void {
    this.onError?.(message);
  }

  // ---------------------------------------------------------------------------
  // Read-through accessors
  // ---------------------------------------------------------------------------

  getAnalyser(): AnalyserNode | null {
    return this.backend?.getAnalyser() ?? null;
  }

  getDecodedPcm(): DecodedPcmView | null {
    return this.backend?.getDecodedPcm?.() ?? null;
  }

  getSyncClock(): SyncClock | null {
    return this.backend?.getSyncClock?.() ?? null;
  }

  getCapabilities(): AudioBackendCapabilities {
    return this.status.capabilities;
  }

  /**
   * Drop the backend but stay usable: the next setOutputMode() creates a new
   * one (React StrictMode runs effect cleanups and then the effects again).
   */
  release(): void {
    this.unsubscribeGraph?.();
    this.unsubscribeGraph = null;
    this.cancelLoad();
    this.backendToken++;
    this.mode = null;
    this.backendReady = Promise.resolve(null);
    this.teardownBackend();
    this.time = 0;
    this.patchStatus({ ...INITIAL_STATUS, backendGeneration: this.status.backendGeneration });
    this.emit();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelLoad();
    this.destroyed = true;
    this.unsubscribeGraph?.();
    this.unsubscribeGraph = null;
    this.backendToken++;
    this.teardownBackend();
    this.listeners.clear();
  }
}
