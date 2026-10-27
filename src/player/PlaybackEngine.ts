// Playback engine (#258): the one owner of the audio backend, the queue cursor,
// load tokens and the playback clock. The UI, Media Session, listening rooms and
// keyboard shortcuts change playback only through its commands; React reads the
// store it writes. Plain TypeScript, no React.
//
// Rules it enforces:
//   1. One audible path: every load stops the current one first.
//   2. Every load gets a token and an AbortController; stale results are dropped
//      and backend loads never overlap.
//   3. An audio-graph rebuild reloads the current track at the clock position.
//   4. 'ended' counts only from the live backend while its track is loaded.
//   5. The clock lives here; persistence and rAF readers sample `clock.now()`.
//   6. Only library tracks reach library endpoints (`recordPlay`).

import type { AudioBackendCapabilities, AudioOutputMode, AudioPlaybackState, ConfigurableAudioBackend, DecodedPcmView, SyncClock } from '../types/audio';
import type { PlaylistTrack } from '../types/library';
import type { RepeatMode } from '../storage/queueStorage';
import { isGaplessActive, type GaplessSettings, type TrackTransitionEvent } from '../types/gapless';
import type { ReplayGainSettings } from '../utils/replayGain';
import { DEFAULT_GAPLESS_MODE, DEFAULT_CROSSFADE_MS } from '../types/gapless';
import { DEFAULT_REPLAYGAIN_MODE } from '../utils/replayGain';
import { selectDecodeStrategy } from '../utils/playbackPath';
import { applyReplayGainToPlayer } from '../hooks/useReplayGainApplication';
import { isLibraryTrack, trackSource } from '../types/track';
import {
  addTrackToQueue,
  getNextQueueIndex,
  getNextQueueTrack,
  getPreviousQueueIndex,
  insertTrackNextForPlayback,
  playNextTrack,
  queueTrackForPlayback,
  removeFromQueue,
  reorderQueueIndex,
  reorderQueueItem,
} from '../utils/queueUtils';
import {
  notify,
  patchClock,
  patchQueue,
  patchSettings,
  patchTransport,
  reportError,
  type PlayerStore,
  type QueueState,
  type TransportState,
} from './playerStore';
import { canTransition, hasLoadedTrack, type TransportStatus } from './transport';

/** Listening-room role: any role forces the native `<audio>` clock; a guest never advances on its own. */
export type ListeningSyncMode = 'off' | 'host' | 'guest';

export interface LoadOptions {
  /** Start playback once loaded (default true). */
  autoplay?: boolean;
  /** Seek here after loading (seconds); wins over `restorePosition`. */
  startAt?: number;
  /** Resume the saved position for this track (default true). */
  restorePosition?: boolean;
  /** Queue slot the track plays from; moves the queue cursor. */
  index?: number;
  /** Internal reload (graph rebuild, engine switch): no toast, no play count. */
  silent?: boolean;
}

export interface EngineAudioSettings {
  eqGains: number[];
  playbackRate: number;
  gapless: GaplessSettings;
  replayGain: ReplayGainSettings;
}

export const DEFAULT_ENGINE_AUDIO: EngineAudioSettings = {
  eqGains: [],
  playbackRate: 1,
  gapless: { mode: DEFAULT_GAPLESS_MODE, crossfadeMs: DEFAULT_CROSSFADE_MS },
  replayGain: { mode: DEFAULT_REPLAYGAIN_MODE, limiterEnabled: false },
};

/** What play() did: `blocked` means the browser's autoplay policy refused (needs a click). */
export type PlayResult = 'playing' | 'blocked' | 'pending' | 'idle';

/** Everything the engine touches outside itself; `engineDeps.ts` has the browser wiring. */
export interface EngineDeps {
  createBackend(mode: AudioOutputMode): Promise<ConfigurableAudioBackend>;
  subscribeGraphRecreated(listener: () => void): () => void;
  /** URLs to try in order (fast mirror first). */
  candidateUrls(url: string): string[];
  /** Whole-file bytes, offline cache first. */
  fetchTrackBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer>;
  probeContentLength(url: string, signal: AbortSignal): Promise<number | null>;
  recordPlay(trackId: string): void;
  /** Fill in ReplayGain fields the catalog lacks (reads the file's tags). */
  enrichReplayGain(track: PlaylistTrack): Promise<PlaylistTrack>;
  /** Build a `local` track from a dropped or picked file. */
  readLocalFile(file: File): Promise<PlaylistTrack>;
  readSavedPosition(trackId: string): number | null;
  /** projectM PCM feed; returns its detach function. */
  attachVisualizerFeed(backend: ConfigurableAudioBackend): () => void;
  onTrackChange(): void;
  /** Monotonic milliseconds. */
  now(): number;
}

/** Store clock updates at most this often (React readers); rAF reads `clock.now()`. */
export const CLOCK_PUBLISH_MS = 250;
/** A position change this far from the extrapolated clock is a seek, not drift. */
const CLOCK_JUMP_S = 1;

interface ClockSample {
  position: number;
  duration: number;
  playing: boolean;
  /** `deps.now()` when sampled. */
  at: number;
}

interface QueueEntry {
  index: number;
  track: PlaylistTrack;
}

function abortError(): DOMException {
  return new DOMException('Superseded by a newer load', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function sameGapless(a: GaplessSettings, b: GaplessSettings): boolean {
  return a.mode === b.mode && a.crossfadeMs === b.crossfadeMs;
}

function sameReplayGain(a: ReplayGainSettings, b: ReplayGainSettings): boolean {
  return a.mode === b.mode && a.limiterEnabled === b.limiterEnabled;
}

export class PlaybackEngine {
  /** Honest position: the last backend report, extrapolated while playing. */
  readonly clock = { now: (): number => this.clockNow() };

  private backend: ConfigurableAudioBackend | null = null;
  private backendMode: AudioOutputMode | null = null;
  private backendReady: Promise<ConfigurableAudioBackend | null> = Promise.resolve(null);
  private backendSeq = 0;
  private detachFeed: (() => void) | null = null;
  /** Last analyser handed out; a new node bumps `graphGeneration` so readers re-fetch. */
  private analyser: AnalyserNode | null = null;
  /** Serializes backend loads so a slow, superseded load cannot finish last. */
  private backendQueue: Promise<unknown> = Promise.resolve();

  private loadToken = 0;
  private loadAbort: AbortController | null = null;
  private autoplayPending = false;

  private sample: ClockSample = { position: 0, duration: 0, playing: false, at: 0 };
  private lastClockPublish = -Infinity;
  /** Rate the backend is running at (user rate, or a room's drift nudge). */
  private rate = 1;

  private audio: EngineAudioSettings = DEFAULT_ENGINE_AUDIO;
  private syncMode: ListeningSyncMode = 'off';
  private preloaded: QueueEntry | null = null;
  private pendingLocalFiles: File[] = [];
  private restoreVolume = 1;

  private attachments = 0;
  private running = false;
  private cleanups: Array<() => void> = [];
  private readonly trackStartedListeners = new Set<(track: PlaylistTrack) => void>();

  constructor(readonly store: PlayerStore, private readonly deps: EngineDeps) {
    this.restoreVolume = store.getState().settings.volume || 1;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the engine (creates the backend) and return a detach function. The
   * last detach disposes it a microtask later, so StrictMode's detach → attach
   * keeps the backend.
   */
  attach(): () => void {
    this.attachments += 1;
    if (!this.running) this.start();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.attachments -= 1;
      queueMicrotask(() => {
        if (this.attachments === 0) this.dispose();
      });
    };
  }

  private start(): void {
    this.running = true;
    this.cleanups.push(
      this.deps.subscribeGraphRecreated(() => this.onGraphRecreated()),
      this.store.subscribe((state, prev) => {
        if (state.queue !== prev.queue) this.onQueueChanged(prev.queue);
      }),
    );
    this.createBackend(this.store.getState().settings.outputMode);
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.cancelLoad();
    this.backendSeq += 1;
    this.backendReady = Promise.resolve(null);
    this.teardownBackend();
    patchTransport(this.store, { status: 'idle', loadingTrackId: undefined });
  }

  /** Called once per track that starts (not on silent reloads). */
  onTrackStarted(listener: (track: PlaylistTrack) => void): () => void {
    this.trackStartedListeners.add(listener);
    return () => { this.trackStartedListeners.delete(listener); };
  }

  // ---------------------------------------------------------------------------
  // Backend
  // ---------------------------------------------------------------------------

  /** The only path that constructs a backend: start() and setOutputMode(). */
  private createBackend(mode: AudioOutputMode): void {
    const seq = ++this.backendSeq;
    this.teardownBackend();
    this.backendReady = this.deps.createBackend(mode).then(async (backend) => {
      if (seq !== this.backendSeq) {
        backend.destroy();
        return null;
      }
      this.wireBackend(backend, mode);
      try {
        await backend.initialize();
      } catch (err) {
        if (seq === this.backendSeq) reportError(this.store, errorMessage(err, `${mode} initialization failed`));
      }
      return seq === this.backendSeq ? backend : null;
    }, (err: unknown) => {
      if (seq === this.backendSeq) reportError(this.store, errorMessage(err, `${mode} initialization failed`));
      return null;
    });
  }

  private wireBackend(backend: ConfigurableAudioBackend, mode: AudioOutputMode): void {
    backend.setStateChangeCallback((state) => this.onBackendState(backend, state));
    backend.setOnEndedCallback((event) => this.onBackendEnded(backend, event));
    const { volume, muted } = this.store.getState().settings;
    backend.setVolume(muted ? 0 : volume);
    backend.setEQGains(this.audio.eqGains);
    backend.setPlaybackRate(this.audio.playbackRate);
    this.rate = this.audio.playbackRate;
    // setGaplessSettings only: the deprecated setCrossfadeEnabled(false) resets 'gapless' to 'off'.
    backend.setGaplessSettings?.(this.audio.gapless);
    backend.setNativeOnly?.(this.syncMode !== 'off');
    this.detachFeed = this.deps.attachVisualizerFeed(backend);
    this.backend = backend;
    this.backendMode = mode;
    patchTransport(this.store, { capabilities: backend.getCapabilities() });
    this.refreshAnalyser(true);
  }

  /** The graph (and its analyser) is created lazily by the first load and rebuilt on rate/latency changes. */
  private refreshAnalyser(force = false): void {
    const analyser = this.backend?.getAnalyser() ?? null;
    if (!force && analyser === this.analyser) return;
    this.analyser = analyser;
    const { graphGeneration } = this.store.getState().transport;
    patchTransport(this.store, { graphGeneration: graphGeneration + 1 });
  }

  private teardownBackend(): void {
    const backend = this.backend;
    this.backend = null;
    this.backendMode = null;
    this.preloaded = null;
    this.detachFeed?.();
    this.detachFeed = null;
    if (!backend) return;
    backend.setOnEndedCallback(undefined);
    backend.destroy();
  }

  private onBackendState(backend: ConfigurableAudioBackend, state: AudioPlaybackState): void {
    if (backend !== this.backend) return;
    const { transport } = this.store.getState();
    // Mid-load reports describe the track being replaced (or a half-loaded one); load() re-samples.
    if (transport.status === 'loading') return;
    const wasPlaying = this.sample.playing;
    const jumped = Math.abs(state.currentTime - this.clockNow()) > CLOCK_JUMP_S;
    this.sample = { position: state.currentTime, duration: state.duration, playing: state.isPlaying, at: this.deps.now() };

    const patch: Partial<TransportState> = {
      prebufferingNext: Boolean(state.prebufferingNext),
      capabilities: backend.getCapabilities(),
    };
    if (state.duration > 0) patch.duration = state.duration;
    if (hasLoadedTrack(transport.status)) {
      if (state.isPlaying) patch.status = 'playing';
      else if (transport.status === 'playing') patch.status = 'paused';
    }
    this.patchTransportChecked(patch);
    this.publishClock(state.isPlaying !== wasPlaying || jumped);
  }

  private onBackendEnded(backend: ConfigurableAudioBackend, event?: TrackTransitionEvent): void {
    // A replaced backend, or a track a newer load superseded, cannot advance the queue.
    if (backend !== this.backend) return;
    const { status } = this.store.getState().transport;
    if (!hasLoadedTrack(status)) return;
    if (event?.alreadyPlayingNext) {
      this.advanceToNextInPlace();
      return;
    }
    this.sample = { ...this.sample, playing: false, position: this.sample.duration || this.sample.position, at: this.deps.now() };
    this.setStatus('ended');
    this.publishClock(true);
    if (this.syncMode === 'guest') return;
    if (this.store.getState().queue.repeatMode === 'one') {
      void this.play();
      return;
    }
    const next = this.nextInQueue();
    if (next) void this.load(next.track, { index: next.index, restorePosition: false });
  }

  /** The backend already plays the preloaded successor (gapless / crossfade): move the cursor only. */
  private advanceToNextInPlace(): void {
    const next = this.nextInQueue();
    this.preloaded = null;
    if (!next) return;
    const duration = next.track.duration ?? 0;
    this.sample = { position: 0, duration, playing: true, at: this.deps.now() };
    patchTransport(this.store, { currentTrack: next.track, duration });
    patchQueue(this.store, { currentIndex: next.index });
    this.deps.onTrackChange();
    void this.deps.enrichReplayGain(next.track).catch(() => next.track).then((enriched) => {
      if (this.store.getState().transport.currentTrack !== next.track) return;
      if (enriched !== next.track) patchTransport(this.store, { currentTrack: enriched });
      this.applyReplayGain(enriched);
    });
    this.trackStarted(next.track, false);
    this.publishClock(true);
  }

  private onGraphRecreated(): void {
    this.refreshAnalyser(true);
    const { transport, queue } = this.store.getState();
    // A load in flight attaches to the new graph itself (ensureForTrack rebuilds mid-load).
    const track = transport.currentTrack;
    if (!track || !hasLoadedTrack(transport.status)) return;
    // The old graph is closed: re-attach by reloading at the clock position (#258 rule 3).
    void this.load(track, {
      index: queue.tracks[queue.currentIndex]?.id === track.id ? queue.currentIndex : undefined,
      startAt: this.clockNow(),
      autoplay: transport.status === 'playing',
      restorePosition: false,
      silent: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /** Load `track` into the backend; resolves true once it is loaded (and playing, with autoplay). */
  async load(track: PlaylistTrack, options: LoadOptions = {}): Promise<boolean> {
    const { autoplay = true, startAt, restorePosition = true, index, silent = false } = options;
    this.cancelLoad();
    const token = this.loadToken;
    const signal = this.loadAbort!.signal;
    this.autoplayPending = autoplay;

    if (index !== undefined) patchQueue(this.store, { currentIndex: index });
    const duration = track.duration && track.duration > 0 ? track.duration : 0;
    this.sample = { position: startAt ?? 0, duration, playing: false, at: this.deps.now() };
    this.forceStatus('loading', { currentTrack: track, loadingTrackId: track.id, duration });
    this.publishClock(true);
    if (!silent) this.deps.onTrackChange();
    // Rule 1: silence the current track before the next one loads.
    this.backend?.stop();

    try {
      const backend = await this.backendReady;
      this.assertCurrent(token);
      if (!backend) throw new Error('No audio output is available');

      const enriched = await this.deps.enrichReplayGain(track).catch(() => track);
      this.assertCurrent(token);
      if (enriched !== track) patchTransport(this.store, { currentTrack: enriched });
      this.applyReplayGain(enriched);

      await this.exclusive(token, () => this.loadIntoBackend(backend, enriched, signal));
      this.assertCurrent(token);

      const position = startAt ?? (restorePosition ? this.deps.readSavedPosition(track.id) : null);
      const seekTo = position !== null && position > 0 ? position : null;
      if (seekTo !== null) backend.seek(seekTo);
      const loaded = backend.getState();
      this.sample = {
        position: seekTo ?? loaded.currentTime,
        duration: loaded.duration > 0 ? loaded.duration : duration,
        playing: loaded.isPlaying,
        at: this.deps.now(),
      };
      const mode = this.backendMode;
      this.forceStatus('ready', {
        loadingTrackId: undefined,
        duration: this.sample.duration,
        capabilities: backend.getCapabilities(),
        playbackPath: mode === 'web-audio' ? null : backend.getPlaybackPath?.() ?? null,
      });
      this.publishClock(true);
      this.refreshAnalyser();
      if (this.autoplayPending) {
        if (await this.startBackend(backend) === 'blocked') notify(this.store, 'Press play to start playback', 'info');
      } else if (loaded.isPlaying) {
        this.setStatus('playing');
      }
      this.assertCurrent(token);
      if (!silent) this.trackStarted(enriched, true);
      this.preloadNext();
      return true;
    } catch (err) {
      if (token !== this.loadToken || isAbortError(err)) return false;
      console.error('Failed to play track:', err);
      this.forceStatus('error', { loadingTrackId: undefined });
      reportError(this.store, `Playback failed: ${errorMessage(err, 'Failed to play track')}`);
      return false;
    }
  }

  /** Bump the load token and abort the previous load's fetches. */
  private cancelLoad(): void {
    this.loadToken += 1;
    this.loadAbort?.abort();
    this.loadAbort = new AbortController();
  }

  private assertCurrent(token: number): void {
    if (token !== this.loadToken) throw abortError();
  }

  /** Run backend loads one at a time; a load superseded while queued never starts. */
  private exclusive<T>(token: number, fn: () => Promise<T>): Promise<T> {
    const run = this.backendQueue.then(() => {
      this.assertCurrent(token);
      return fn();
    });
    this.backendQueue = run.catch(() => undefined);
    return run;
  }

  private async loadIntoBackend(backend: ConfigurableAudioBackend, track: PlaylistTrack, signal: AbortSignal): Promise<void> {
    const mode = this.backendMode;
    if (trackSource(track) === 'local') {
      if (mode === 'streaming') throw new Error('Streaming mode does not support local files. Switch to a buffered audio mode.');
      if (!track.file) throw new Error('This local file is no longer available; add it again.');
      await backend.loadFromArrayBuffer(await track.file.arrayBuffer(), track.file.name);
      return;
    }

    const expectedDuration = track.duration && track.duration > 0 ? track.duration : undefined;
    const candidates = this.deps.candidateUrls(track.url);
    let lastError: unknown;
    for (const url of candidates) {
      try {
        if (mode === 'streaming' && backend.loadFromURL) {
          await backend.loadFromURL(url, { expectedDuration });
        } else if (mode === 'worklet' || mode === 'sdl') {
          const contentLength = await this.deps.probeContentLength(url, signal);
          const strategy = selectDecodeStrategy(contentLength, { outputMode: mode, url });
          if (strategy === 'hifi-stream' && backend.loadFromURLStreaming) {
            await backend.loadFromURLStreaming(url, { expectedDuration });
          } else {
            await backend.loadFromArrayBuffer(await this.deps.fetchTrackBytes(url, signal));
          }
        } else {
          await backend.loadFromArrayBuffer(await this.deps.fetchTrackBytes(url, signal));
        }
        return;
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw abortError();
        lastError = err;
      }
    }
    const message = `Failed to load audio from any source: ${candidates.join(', ')}`;
    throw new Error(lastError instanceof Error && lastError.message ? `${message} (${lastError.message})` : message);
  }

  private async startBackend(backend: ConfigurableAudioBackend): Promise<PlayResult> {
    try {
      await backend.play();
    } catch (err) {
      // Autoplay policy: the track stays loaded; the next click on play starts it.
      if (err instanceof DOMException && err.name === 'NotAllowedError') return 'blocked';
      throw err;
    }
    if (backend !== this.backend) return 'idle';
    const state = backend.getState();
    if (!state.isPlaying) return 'idle';
    this.sample = { position: state.currentTime, duration: state.duration || this.sample.duration, playing: true, at: this.deps.now() };
    this.setStatus('playing');
    this.publishClock(true);
    return 'playing';
  }

  private trackStarted(track: PlaylistTrack, toast: boolean): void {
    if (isLibraryTrack(track)) this.deps.recordPlay(track.id);
    if (toast) notify(this.store, `Playing: ${track.title || track.name}`, 'info');
    this.trackStartedListeners.forEach((listener) => listener(track));
  }

  // ---------------------------------------------------------------------------
  // Transport commands
  // ---------------------------------------------------------------------------

  async play(): Promise<PlayResult> {
    const { transport, queue } = this.store.getState();
    switch (transport.status) {
      case 'loading':
        this.autoplayPending = true;
        return 'pending';
      case 'idle':
      case 'error': {
        // Nothing loaded: replay the stopped/failed track, else start the queue cursor.
        const current = transport.currentTrack;
        const index = current
          ? queue.tracks.findIndex((t) => t.id === current.id)
          : Math.max(0, Math.min(queue.currentIndex, queue.tracks.length - 1));
        const track = current ?? queue.tracks[index];
        if (!track) return 'idle';
        const ok = await this.load(track, { index: index >= 0 ? index : undefined, restorePosition: !current });
        return ok && this.store.getState().transport.status === 'playing' ? 'playing' : 'idle';
      }
      default: {
        const backend = this.backend;
        if (!backend) return 'idle';
        try {
          return await this.startBackend(backend);
        } catch (err) {
          reportError(this.store, `Playback failed: ${errorMessage(err, 'could not start')}`);
          return 'idle';
        }
      }
    }
  }

  pause(): void {
    const { status } = this.store.getState().transport;
    if (status === 'loading') {
      this.autoplayPending = false;
      return;
    }
    if (!this.backend || !hasLoadedTrack(status)) return;
    this.backend.pause();
    this.sample = { ...this.sample, position: this.clockNow(), playing: false, at: this.deps.now() };
    if (status === 'playing') this.setStatus('paused');
    this.publishClock(true);
  }

  togglePlay(): void {
    const { status } = this.store.getState().transport;
    if (status === 'playing' || (status === 'loading' && this.autoplayPending)) {
      this.pause();
      return;
    }
    void this.play().then((result) => {
      if (result === 'blocked') notify(this.store, 'Press play to start playback', 'info');
    });
  }

  /** Stop and rewind; the track stays current and play() reloads it from the start. */
  stop(): void {
    this.cancelLoad();
    this.backend?.stop();
    this.preloaded = null;
    this.sample = { position: 0, duration: this.sample.duration, playing: false, at: this.deps.now() };
    this.forceStatus('idle', { loadingTrackId: undefined });
    this.publishClock(true);
  }

  seek(time: number): void {
    const backend = this.backend;
    const { status, duration, seekCount } = this.store.getState().transport;
    if (!backend || !hasLoadedTrack(status)) return;
    const target = Math.max(0, duration > 0 ? Math.min(time, duration) : time);
    backend.seek(target);
    this.sample = { ...this.sample, position: target, at: this.deps.now() };
    patchTransport(this.store, { seekCount: seekCount + 1 });
    if (status === 'ended') this.setStatus('paused');
    this.publishClock(true);
  }

  seekBy(deltaSeconds: number): void {
    this.seek(this.clockNow() + deltaSeconds);
  }

  next(): void {
    const { tracks, currentIndex, shuffle, repeatMode } = this.store.getState().queue;
    const preloaded = this.validPreload();
    const index = preloaded ? preloaded.index : getNextQueueIndex(tracks.length, currentIndex, shuffle, repeatMode);
    const track = tracks[index];
    if (track) void this.load(track, { index });
  }

  prev(): void {
    const { tracks, currentIndex, repeatMode } = this.store.getState().queue;
    const index = getPreviousQueueIndex(tracks.length, currentIndex, repeatMode);
    const track = tracks[index];
    if (track) void this.load(track, { index });
  }

  /** The only command that recreates the backend. A loaded track resumes on the new engine. */
  setOutputMode(mode: AudioOutputMode): void {
    const { settings, transport, queue } = this.store.getState();
    if (mode === settings.outputMode) return;
    const track = transport.currentTrack;
    const resume = track && (hasLoadedTrack(transport.status) || transport.status === 'loading')
      ? {
          track,
          index: queue.tracks[queue.currentIndex]?.id === track.id ? queue.currentIndex : undefined,
          startAt: this.clockNow(),
          autoplay: transport.status === 'playing' || (transport.status === 'loading' && this.autoplayPending),
        }
      : null;
    patchSettings(this.store, { outputMode: mode });
    this.cancelLoad();
    this.forceStatus('idle', { loadingTrackId: undefined, playbackPath: null });
    if (!this.running) return;
    this.createBackend(mode);

    const files = this.pendingLocalFiles;
    this.pendingLocalFiles = [];
    void this.backendReady.then((backend) => {
      if (!backend) return;
      if (files.length > 0) {
        void this.addLocalFiles(files);
      } else if (resume && !(mode === 'streaming' && trackSource(resume.track) === 'local')) {
        void this.load(resume.track, { ...resume, restorePosition: false, silent: true });
      }
    });
  }

  /** Add dropped/picked files to the queue and play the first (switches off streaming, which cannot). */
  async addLocalFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (this.store.getState().settings.outputMode === 'streaming') {
      this.pendingLocalFiles = files;
      notify(this.store, 'Switched to buffered mode for local files', 'info');
      this.setOutputMode('worklet');
      return;
    }
    const tracks = await Promise.all(files.map((file) => this.deps.readLocalFile(file)));
    const first = tracks[0];
    if (!first) return;
    const start = this.store.getState().queue.tracks.length;
    patchQueue(this.store, { tracks: [...this.store.getState().queue.tracks, ...tracks] });
    await this.load(first, { index: start, restorePosition: false });
  }

  // ---------------------------------------------------------------------------
  // Queue commands
  // ---------------------------------------------------------------------------

  setQueue(tracks: PlaylistTrack[], options: { currentIndex?: number; shuffle?: boolean; repeatMode?: RepeatMode } = {}): void {
    const { queue } = this.store.getState();
    patchQueue(this.store, {
      tracks,
      currentIndex: options.currentIndex ?? -1,
      shuffle: options.shuffle ?? queue.shuffle,
      repeatMode: options.repeatMode ?? queue.repeatMode,
    });
  }

  /** Replace the queue and start at `startIndex`. */
  playQueue(tracks: PlaylistTrack[], startIndex = 0): void {
    const track = tracks[startIndex];
    if (!track) return;
    this.setQueue(tracks, { currentIndex: startIndex });
    void this.load(track, { index: startIndex });
  }

  /** Play from its queue slot, appending it first when it is not queued (#258 bug 7). */
  playTrack(track: PlaylistTrack): void {
    const { queue } = this.store.getState();
    const { queue: tracks, index } = queueTrackForPlayback(queue.tracks, track);
    if (tracks !== queue.tracks) patchQueue(this.store, { tracks });
    void this.load(track, { index });
  }

  /** Insert after the current track (or reuse its slot) and play it; the rest of the queue stays. */
  playNextNow(track: PlaylistTrack): void {
    const { queue } = this.store.getState();
    const { queue: tracks, index } = insertTrackNextForPlayback(queue.tracks, track, queue.currentIndex);
    if (tracks !== queue.tracks) patchQueue(this.store, { tracks });
    void this.load(track, { index });
  }

  playAt(index: number): void {
    const track = this.store.getState().queue.tracks[index];
    if (track) void this.load(track, { index });
  }

  /** Append unless already queued; returns whether it was added. */
  enqueue(track: PlaylistTrack): boolean {
    const { tracks } = this.store.getState().queue;
    const next = addTrackToQueue(tracks, track);
    if (next === tracks) return false;
    patchQueue(this.store, { tracks: next });
    return true;
  }

  /** Append the tracks not already queued; returns how many were added. */
  enqueueAll(tracks: PlaylistTrack[]): number {
    const { tracks: queued } = this.store.getState().queue;
    const known = new Set(queued.map((t) => t.id));
    const added = tracks.filter((t) => !known.has(t.id));
    if (added.length > 0) patchQueue(this.store, { tracks: [...queued, ...added] });
    return added.length;
  }

  /** Queue right after the current track (no-op when already queued). */
  insertNext(track: PlaylistTrack): number {
    const { tracks, currentIndex } = this.store.getState().queue;
    const { queue: next, insertAt } = playNextTrack(tracks, track, currentIndex);
    if (insertAt >= 0) patchQueue(this.store, { tracks: next });
    return insertAt;
  }

  removeFromQueue(index: number): void {
    const { tracks, currentIndex } = this.store.getState().queue;
    if (index < 0 || index >= tracks.length) return;
    const next = removeFromQueue(tracks, index);
    let cursor = currentIndex;
    if (currentIndex !== -1) {
      if (index < currentIndex) cursor = currentIndex - 1;
      else if (index === currentIndex) cursor = next.length > 0 ? Math.min(currentIndex, next.length - 1) : -1;
    }
    patchQueue(this.store, { tracks: next, currentIndex: cursor });
  }

  reorderQueue(from: number, to: number): void {
    const { tracks, currentIndex } = this.store.getState().queue;
    if (from === to) return;
    patchQueue(this.store, {
      tracks: reorderQueueItem(tracks, from, to),
      currentIndex: reorderQueueIndex(currentIndex, from, to),
    });
  }

  clearQueue(): void {
    patchQueue(this.store, { tracks: [], currentIndex: -1 });
  }

  setShuffle(shuffle: boolean): void {
    patchQueue(this.store, { shuffle });
  }

  setRepeatMode(repeatMode: RepeatMode): void {
    patchQueue(this.store, { repeatMode });
  }

  private onQueueChanged(prev: QueueState): void {
    // The album reference level depends on the queue around the current track.
    if (this.store.getState().queue.tracks !== prev.tracks) this.applyReplayGain();
    this.preloadNext();
  }

  /** The preloaded successor, if it is still where it was queued. */
  private validPreload(): QueueEntry | null {
    const pre = this.preloaded;
    const { tracks, currentIndex } = this.store.getState().queue;
    return pre && pre.index !== currentIndex && tracks[pre.index]?.id === pre.track.id ? pre : null;
  }

  private nextInQueue(): QueueEntry | null {
    const { tracks, currentIndex, shuffle, repeatMode } = this.store.getState().queue;
    return this.validPreload() ?? getNextQueueTrack(tracks, currentIndex, shuffle, repeatMode);
  }

  /** Hand the backend the successor for gapless / crossfade (once a track is loaded). */
  private preloadNext(): void {
    const backend = this.backend;
    if (!backend) return;
    const { transport, queue } = this.store.getState();
    const blocked = !isGaplessActive(this.audio.gapless)
      || this.syncMode === 'guest'
      || queue.repeatMode === 'one'
      || !hasLoadedTrack(transport.status);
    // Shuffle picks at random: keep a still-valid pick instead of re-rolling on every edit.
    const next = blocked ? null : (queue.shuffle ? this.validPreload() : null)
      ?? getNextQueueTrack(queue.tracks, queue.currentIndex, queue.shuffle, queue.repeatMode);
    const usable = next && !(trackSource(next.track) === 'local' && this.backendMode === 'streaming') ? next : null;
    if (!usable) {
      if (this.preloaded) backend.clearPreload?.();
      this.preloaded = null;
      return;
    }
    if (this.preloaded?.index === usable.index && this.preloaded.track.url === usable.track.url) return;
    this.preloaded = usable;
    backend.preloadNext?.({ url: usable.track.url, duration: usable.track.duration });
  }

  /** Apply catalog edits (rating, tags…) to the loaded track and its queue entries. */
  patchTrack(id: string, updates: Partial<PlaylistTrack>): void {
    const { transport, queue } = this.store.getState();
    if (transport.currentTrack?.id === id) {
      patchTransport(this.store, { currentTrack: { ...transport.currentTrack, ...updates } });
    }
    if (queue.tracks.some((t) => t.id === id)) {
      patchQueue(this.store, { tracks: queue.tracks.map((t) => (t.id === id ? { ...t, ...updates } : t)) });
    }
  }

  // ---------------------------------------------------------------------------
  // Volume and audio settings
  // ---------------------------------------------------------------------------

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume));
    if (v > 0) this.restoreVolume = v;
    patchSettings(this.store, { volume: v, muted: false });
    this.backend?.setVolume(v);
  }

  toggleMute(): void {
    const { muted, volume } = this.store.getState().settings;
    if (!muted) {
      if (volume > 0) this.restoreVolume = volume;
      patchSettings(this.store, { muted: true });
      this.backend?.setVolume(0);
      return;
    }
    patchSettings(this.store, { muted: false, volume: this.restoreVolume });
    this.backend?.setVolume(this.restoreVolume);
  }

  /** EQ, rate, gapless and ReplayGain come from `useAudioSettings`; unchanged values are ignored. */
  setAudioSettings(patch: Partial<EngineAudioSettings>): void {
    const prev = this.audio;
    const next = { ...prev, ...patch };
    this.audio = next;
    const backend = this.backend;
    if (next.eqGains !== prev.eqGains) backend?.setEQGains(next.eqGains);
    if (next.playbackRate !== prev.playbackRate) this.setBackendRate(next.playbackRate);
    if (!sameGapless(next.gapless, prev.gapless)) {
      backend?.setGaplessSettings?.(next.gapless);
      if (!isGaplessActive(next.gapless)) this.preloaded = null;
      this.preloadNext();
    }
    if (!sameReplayGain(next.replayGain, prev.replayGain)) this.applyReplayGain();
  }

  private setBackendRate(rate: number): void {
    // Re-base the clock so extrapolation switches rate at this instant.
    this.sample = { ...this.sample, position: this.clockNow(), at: this.deps.now() };
    this.rate = rate;
    this.backend?.setPlaybackRate(rate);
  }

  private applyReplayGain(track: PlaylistTrack | null = this.store.getState().transport.currentTrack): void {
    if (!track) return;
    applyReplayGainToPlayer({
      player: this.backend,
      track,
      queue: this.store.getState().queue.tracks,
      settings: this.audio.replayGain,
    });
  }

  // ---------------------------------------------------------------------------
  // Listening rooms
  // ---------------------------------------------------------------------------

  setSyncMode(mode: ListeningSyncMode): void {
    if (mode === this.syncMode) return;
    this.syncMode = mode;
    this.backend?.setNativeOnly?.(mode !== 'off');
    this.preloadNext();
  }

  getSyncClock(): SyncClock | null {
    return this.backend?.getSyncClock?.() ?? null;
  }

  /** A room guest's drift correction; the user's rate setting is untouched. */
  nudgeRate(rate: number): void {
    this.setBackendRate(rate);
  }

  // ---------------------------------------------------------------------------
  // Read-only access
  // ---------------------------------------------------------------------------

  getAnalyser(): AnalyserNode | null {
    return this.backend?.getAnalyser() ?? null;
  }

  getDecodedPcm(): DecodedPcmView | null {
    return this.backend?.getDecodedPcm?.() ?? null;
  }

  getCapabilities(): AudioBackendCapabilities {
    return this.store.getState().transport.capabilities;
  }

  /** Backend state for code that needs the raw numbers (listening rooms). */
  getBackendState(): AudioPlaybackState | null {
    return this.backend?.getState() ?? null;
  }

  // ---------------------------------------------------------------------------
  // Clock and status
  // ---------------------------------------------------------------------------

  private clockNow(): number {
    const { position, duration, playing, at } = this.sample;
    if (!playing) return position;
    const t = position + ((this.deps.now() - at) / 1000) * this.rate;
    return duration > 0 ? Math.min(t, duration) : t;
  }

  private publishClock(force = false): void {
    const now = this.deps.now();
    if (!force && now - this.lastClockPublish < CLOCK_PUBLISH_MS) return;
    this.lastClockPublish = now;
    patchClock(this.store, { position: this.clockNow(), duration: this.store.getState().transport.duration });
  }

  private setStatus(status: TransportStatus): void {
    this.patchTransportChecked({ status });
  }

  /** Patch transport, dropping a status change the state machine does not allow. */
  private patchTransportChecked(patch: Partial<TransportState>): void {
    const from = this.store.getState().transport.status;
    if (patch.status && !canTransition(from, patch.status)) {
      const { status: _rejected, ...rest } = patch;
      void _rejected;
      patchTransport(this.store, rest);
      return;
    }
    patchTransport(this.store, patch);
  }

  /** Engine-initiated transitions (load, stop, error) are always legal from any state. */
  private forceStatus(status: TransportStatus, patch: Partial<TransportState> = {}): void {
    patchTransport(this.store, { ...patch, status });
  }
}

