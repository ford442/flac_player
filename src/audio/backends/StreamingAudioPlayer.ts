// Streaming audio player — hi-fi WASM FLAC streaming (primary) with native <audio> fallback.
//
// Hi-Fi path:  HTTP Range → StreamingDecoder → AudioWorklet ring buffer → Analyser
// Native path: <audio> element (WAV/MP3 or when WASM/worklet unavailable)
//
// Gapless / crossfade is implemented on the native <audio> path (dual elements).
// Listening rooms force the native path (setNativeOnly) and read its SyncClock.
//
// Only one path produces sound: every load halts the native element(s) and the
// worklet before starting the next path. An element is bound to its first
// MediaElementAudioSourceNode, so a graph recreate retires it (pause, drop src,
// detach listeners) and moves the current URL / position onto a fresh element.

import { AudioContextManager, isAudioContextSinkSupported, sharedAudioContextManager } from '../AudioContextManager';
import { ensureContextForUrl } from '../ensureContextForSource';
import { WorkletAudioPlayer } from './worklet/WorkletAudioPlayer';
import { probeRemoteAudio } from '../../utils/rangeFetch';
import { probeRemoteAudioDuration } from '../../utils/audioHeader';
import {
  describePlaybackPath,
  isFlacUrl,
  selectDecodeStrategy,
  type PlaybackPathInfo,
} from '../../utils/playbackPath';
import { isTrackCached, getOrFetchTrack } from '../../storage/trackCache';
import type { AudioBackendCapabilities, AudioPlaybackState, DecodedPcmView, SyncClock } from '../../types/audio';
import {
  DEFAULT_GAPLESS_MODE,
  DEFAULT_CROSSFADE_MS,
  PRELOAD_AHEAD_S,
  isGaplessActive,
  overlapSeconds,
  type GaplessSettings,
  type PreloadNextOptions,
} from '../../types/gapless';
import { BaseAudioBackend } from './BaseAudioBackend';
import { createSerialQueue } from '../../utils/serialQueue';

/** Lead time (seconds) to start the next native element before the measured end. */
const GAPLESS_SCHEDULE_LEAD_S = 0.05;

type ActivePath = 'native' | 'hifi' | 'buffered';

/** Native-path state carried across a graph recreate onto the replacement element. */
interface NativeResume {
  url: string;
  time: number;
  playing: boolean;
  rate: number;
}

function normalizePreloadOptions(options: PreloadNextOptions | string): PreloadNextOptions {
  return typeof options === 'string' ? { url: options } : options;
}

export class StreamingAudioPlayer extends BaseAudioBackend {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private workletPlayer: WorkletAudioPlayer | null = null;
  private activePath: ActivePath | null = null;

  // Native <audio> path
  private audioElement: HTMLAudioElement;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private nextAudioElement: HTMLAudioElement | null = null;
  private nextSourceNode: MediaElementAudioSourceNode | null = null;
  private nextGainNode: GainNode | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private transitionActive = false;
  private gaplessSettings: GaplessSettings = {
    mode: DEFAULT_GAPLESS_MODE,
    crossfadeMs: DEFAULT_CROSSFADE_MS,
  };
  private nextTrackUrl: string | null = null;
  private nextTrackDuration: number | null = null;
  private currentTrackDuration: number | null = null;
  private prebufferingNext = false;
  private headerProbeAbort: AbortController | null = null;
  private nativeOnly = false;
  /** URL on the current native element; null once halted or retired. */
  private nativeUrl: string | null = null;
  /** Bumped per loadFromURL so a superseded load stops before touching a path. */
  private loadSeq = 0;
  /** Reject pending native `canplay` waits (stop / newer load). */
  private readonly nativeWaitAborts = new Set<() => void>();
  private readonly elementListeners = new WeakMap<HTMLAudioElement, AbortController>();
  /** Worklet loads run one at a time so a superseded decode cannot land last. */
  private readonly workletLoads = createSerialQueue();
  private readonly unsubscribeGraph: () => void;

  private onPCMBlock?: (buffer: Float32Array, channels: number, sampleRate: number) => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    super();
    this.audioElement = this._makeAudioElement();
    this.unsubscribeGraph = contextManager.subscribeGraphRecreated(() => this._onGraphRecreated());
  }

  private _onGraphRecreated(): void {
    const old = this.audioElement;
    const resume: NativeResume | null = this.activePath === 'native' && this.nativeUrl
      ? { url: this.nativeUrl, time: old.currentTime, playing: !old.paused && !old.ended, rate: old.playbackRate }
      : null;

    // Every node below belongs to the closed context.
    this.sourceNode = null;
    this.nextSourceNode = null;
    this.nextGainNode = null;
    this.gainNode = null;
    this.audioContext = null;
    this._dropNativeNext();
    this._retireElement(old);
    this.nativeUrl = null;
    this.audioElement = this._makeAudioElement();

    if (resume && !this.destroyed) void this._reattachNative(resume);
  }

  /** Rebuild the native path on the new context and continue where the old element was. */
  private async _reattachNative(resume: NativeResume): Promise<void> {
    const el = this.audioElement;
    this._connectNativeSource();
    this.nativeUrl = resume.url;
    el.src = resume.url;
    el.playbackRate = resume.rate;
    el.load();
    try {
      await this._waitUntilPlayable(el, resume.url);
    } catch {
      return;
    }
    if (el !== this.audioElement || this.destroyed) return;
    if (resume.time > 0) el.currentTime = resume.time;
    if (resume.playing) {
      try {
        await el.play();
      } catch { /* autoplay policy; the UI shows paused */ }
    }
    this.notifyStateChange();
  }

  private _abortNativeWaits(): void {
    for (const abort of [...this.nativeWaitAborts]) abort();
  }

  /** Stop an element for good: no sound, no network, no events reaching this player. */
  private _retireElement(el: HTMLAudioElement): void {
    this.elementListeners.get(el)?.abort();
    this.elementListeners.delete(el);
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  /** Silence every path before a load; the new path starts from a stopped player. */
  private _haltAllPaths(): void {
    this._abortNativeWaits();
    if (this.nativeUrl !== null) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
      this.audioElement.load();
      this.nativeUrl = null;
    }
    this.workletPlayer?.stop();
  }

  private attachNativeGraph(): { context: AudioContext; gain: GainNode } {
    const ctx = this.contextManager.getContext();
    if (this.audioContext !== ctx || !this.gainNode) {
      this.audioContext = ctx;
      this.gainNode = ctx.createGain();
      this.contextManager.connectInput(this.gainNode);
    }
    return { context: this.audioContext, gain: this.gainNode };
  }

  async initialize(): Promise<void> {
    if (!this.workletPlayer) {
      this.workletPlayer = new WorkletAudioPlayer(this.contextManager);
      // A halted worklet must not report state or `ended` over the native path.
      this.workletPlayer.setStateChangeCallback((state) => {
        if (this.activePath !== 'native') this.notifyStateChange(state);
      });
      this.workletPlayer.setOnEndedCallback((event) => {
        if (this.activePath !== 'native') this.onEndedCallback?.(event);
      });
      if (this.onPCMBlock) {
        this.workletPlayer.setPCMCallback(this.onPCMBlock);
      }
    }
  }

  getPlaybackPath(): PlaybackPathInfo | null {
    if (this.activePath === 'native') return describePlaybackPath('native-stream');
    if (this.activePath === 'hifi') return this.workletPlayer?.getPlaybackPath() ?? describePlaybackPath('hifi-stream');
    if (this.activePath === 'buffered') return describePlaybackPath('buffered');
    return null;
  }

  setPCMCallback(
    callback: ((buffer: Float32Array, channels: number, sampleRate: number) => void) | undefined
  ): void {
    this.onPCMBlock = callback;
    this.workletPlayer?.setPCMCallback(callback);
  }

  async loadFromArrayBuffer(_buffer: ArrayBuffer, _filename?: string): Promise<void> {
    void _buffer;
    void _filename;
    throw new Error('Streaming mode requires a URL; switch to a buffered backend for local files.');
  }

  private _makeAudioElement(): HTMLAudioElement {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';

    const listeners = new AbortController();
    this.elementListeners.set(el, listeners);
    const { signal } = listeners;
    // Only the current element drives state; a preloaded next element stays quiet.
    const onCurrent = (handler: () => void) => () => {
      if (el === this.audioElement) handler();
    };
    const notify = onCurrent(() => this.notifyStateChange());

    el.addEventListener('timeupdate', onCurrent(() => {
      this.notifyStateChange();
      this._maybeTriggerTransition();
    }), { signal });
    el.addEventListener('play', notify, { signal });
    el.addEventListener('pause', notify, { signal });
    el.addEventListener('durationchange', notify, { signal });
    el.addEventListener('loadedmetadata', notify, { signal });
    el.addEventListener('ended', onCurrent(() => {
      this.notifyStateChange();
      if (!this.transitionActive) {
        try { this.onEndedCallback?.(); } catch { /* noop */ }
      }
    }), { signal });
    return el;
  }

  private setPrebuffering(active: boolean): void {
    if (this.prebufferingNext === active) return;
    this.prebufferingNext = active;
    this.notifyStateChange();
  }

  protected override notifyStateChange(override?: AudioPlaybackState): void {
    if (this.guardDestroyed() || !this.onStateChange) return;
    const base = override ?? this.getState();
    this.onStateChange({
      ...base,
      prebufferingNext: this.prebufferingNext,
    });
  }

  private effectiveDuration(el: HTMLAudioElement): number {
    if (this.currentTrackDuration && this.currentTrackDuration > 0) {
      return this.currentTrackDuration;
    }
    return isFinite(el.duration) ? el.duration : 0;
  }

  async loadFromURL(
    url: string,
    options: { expectedDuration?: number } = {}
  ): Promise<void> {
    const seq = ++this.loadSeq;
    this._cancelTransition();
    this._haltAllPaths();
    await this.initialize();
    await ensureContextForUrl(this.contextManager, url);
    this.throwIfSuperseded(seq);
    this.currentTrackDuration = options.expectedDuration && options.expectedDuration > 0
      ? options.expectedDuration
      : null;

    if (isGaplessActive(this.gaplessSettings)) {
      void this._refineDurationFromHeader(url);
    }

    if (this.nativeOnly) {
      this.activePath = 'native';
      return this._loadNative(url);
    }

    let probe;
    try {
      probe = await probeRemoteAudio(url);
    } catch {
      probe = { url, contentLength: null, acceptsRanges: false, contentType: null };
    }
    this.throwIfSuperseded(seq);

    const strategy = selectDecodeStrategy(probe.contentLength, { outputMode: 'streaming', url });

    if (strategy === 'native-stream') {
      this.activePath = 'native';
      return this._loadNative(url);
    }

    if (strategy === 'buffered') {
      this.activePath = 'buffered';
      return this._loadBuffered(seq, url);
    }

    this.activePath = 'hifi';
    return this._loadHifi(seq, url, options.expectedDuration);
  }

  private throwIfSuperseded(seq: number): void {
    if (seq !== this.loadSeq || this.destroyed) {
      throw new DOMException('Load superseded', 'AbortError');
    }
  }

  private async _refineDurationFromHeader(url: string): Promise<void> {
    this.headerProbeAbort?.abort();
    const controller = new AbortController();
    this.headerProbeAbort = controller;
    const parsed = await probeRemoteAudioDuration(url, controller.signal);
    if (controller.signal.aborted) return;
    if (parsed && parsed.durationSeconds > 0) {
      this.currentTrackDuration = parsed.durationSeconds;
      this.notifyStateChange();
    }
  }

  private async _loadHifi(seq: number, url: string, expectedDuration?: number): Promise<void> {
    const cached = await isTrackCached(url);
    let cachedResponse: Response | undefined;
    if (cached) {
      const response = await getOrFetchTrack(url);
      cachedResponse = response;
    }

    await this._loadWorklet(seq, () => this.workletPlayer!.loadFromURLStreaming(url, {
      expectedDuration,
      cachedResponse,
    }));
  }

  private async _loadBuffered(seq: number, url: string): Promise<void> {
    const response = await getOrFetchTrack(url);
    const buffer = await response.arrayBuffer();
    await this._loadWorklet(seq, () => this.workletPlayer!.loadFromArrayBuffer(buffer));
  }

  private async _loadWorklet(seq: number, load: () => Promise<void>): Promise<void> {
    await this.workletLoads(async () => {
      this.throwIfSuperseded(seq);
      await load();
      if (seq !== this.loadSeq) {
        // Landed after a newer load halted the paths (hi-fi streams start on load).
        this.workletPlayer?.stop();
      }
      this.throwIfSuperseded(seq);
    });
    this.workletPlayer?.setGaplessSettings(this.gaplessSettings);
    this.notifyStateChange();
  }

  private _connectNativeSource(): void {
    const { context, gain } = this.attachNativeGraph();
    if (!this.sourceNode) {
      this.sourceNode = context.createMediaElementSource(this.audioElement);
      this.sourceNode.connect(gain);
    }
  }

  private async _loadNative(url: string): Promise<void> {
    this._connectNativeSource();
    this.nativeUrl = url;
    this.audioElement.src = url;
    this.audioElement.load();
    return this._waitUntilPlayable(this.audioElement, url);
  }

  /**
   * Resolve on `canplay`. If a graph recreate retires `el` meanwhile, follow the
   * replacement element when it carries the same URL; halting rejects.
   */
  private _waitUntilPlayable(el: HTMLAudioElement, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const retired = this.elementListeners.get(el)?.signal;
      const cleanup = () => {
        el.removeEventListener('canplay', onCanPlay);
        el.removeEventListener('error', onError);
        retired?.removeEventListener('abort', onRetired);
        this.nativeWaitAborts.delete(onAbort);
      };
      const onCanPlay = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`Failed to load audio: ${url}`)); };
      const onAbort = () => { cleanup(); reject(new DOMException('Load superseded', 'AbortError')); };
      const onRetired = () => {
        cleanup();
        // The replacement is assigned right after the old element is retired.
        queueMicrotask(() => {
          if (this.audioElement !== el && this.nativeUrl === url) {
            this._waitUntilPlayable(this.audioElement, url).then(resolve, reject);
          } else {
            reject(new DOMException('Load superseded', 'AbortError'));
          }
        });
      };
      el.addEventListener('canplay', onCanPlay);
      el.addEventListener('error', onError);
      retired?.addEventListener('abort', onRetired);
      this.nativeWaitAborts.add(onAbort);
    });
  }

  preloadNext(options: PreloadNextOptions | string): void {
    const { url, duration } = normalizePreloadOptions(options);
    if (this.activePath === 'native') {
      this._preloadNativeNext(url, duration);
      return;
    }
    this.workletPlayer?.preloadNext({ url, duration });
  }

  private _preloadNativeNext(url: string, duration?: number): void {
    this.nextTrackUrl = url;
    this.nextTrackDuration = duration && duration > 0 ? duration : null;
    this.setPrebuffering(true);

    if (!this.nextAudioElement) {
      this.nextAudioElement = this._makeAudioElement();
    }
    if (this.nextAudioElement.src !== url) {
      this.nextAudioElement.src = url;
      this.nextAudioElement.load();
    }

    void probeRemoteAudioDuration(url).then((parsed) => {
      if (this.nextTrackUrl !== url) return;
      if (parsed && parsed.durationSeconds > 0) {
        this.nextTrackDuration = parsed.durationSeconds;
      }
      this.setPrebuffering(false);
    }).catch(() => {
      if (this.nextTrackUrl === url) this.setPrebuffering(false);
    });
  }

  clearPreload(): void {
    this._dropNativeNext();
    this.workletPlayer?.clearPreload?.();
  }

  /** Forget the native next track, including a half-open crossfade element. */
  private _dropNativeNext(): void {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    this.transitionActive = false;
    this.nextTrackUrl = null;
    this.nextTrackDuration = null;
    this.setPrebuffering(false);
    if (this.nextAudioElement) {
      this._retireElement(this.nextAudioElement);
      this.nextAudioElement = null;
    }
    if (this.nextSourceNode) {
      try { this.nextSourceNode.disconnect(); } catch { /**/ }
      this.nextSourceNode = null;
    }
    if (this.nextGainNode) {
      try { this.nextGainNode.disconnect(); } catch { /**/ }
      this.nextGainNode = null;
    }
  }

  setGaplessSettings(settings: GaplessSettings): void {
    this.gaplessSettings = settings;
    this.workletPlayer?.setGaplessSettings(settings);
    if (!isGaplessActive(settings)) this._cancelTransition();
  }

  setCrossfadeEnabled(enabled: boolean): void {
    this.setGaplessSettings({
      mode: enabled ? 'crossfade' : 'off',
      crossfadeMs: this.gaplessSettings.crossfadeMs,
    });
  }

  private _maybeTriggerTransition(): void {
    if (this.activePath !== 'native') return;
    if (!isGaplessActive(this.gaplessSettings) || this.transitionActive || !this.nextTrackUrl) return;

    const el = this.audioElement;
    const duration = this.effectiveDuration(el);
    if (duration <= 0) return;

    const overlap = overlapSeconds(this.gaplessSettings);
    const scheduleLead = overlap > 0 ? overlap : GAPLESS_SCHEDULE_LEAD_S;
    const remaining = duration - el.currentTime;

    if (!isFinite(remaining) || remaining > PRELOAD_AHEAD_S) return;
    if (remaining <= scheduleLead && remaining > 0) {
      if (overlap > 0) {
        this._startCrossfade(overlap);
      } else {
        this._startGaplessHandoff();
      }
    }
  }

  private _ensureNextGraph(): void {
    if (!this.nextAudioElement || !this.nextTrackUrl) return;

    const { context } = this.attachNativeGraph();
    if (!this.nextSourceNode) {
      this.nextGainNode = context.createGain();
      this.nextGainNode.gain.value = 0;
      this.contextManager.connectInput(this.nextGainNode);
      this.nextSourceNode = context.createMediaElementSource(this.nextAudioElement);
      this.nextSourceNode.connect(this.nextGainNode);
    }

    if (this.nextAudioElement.src !== this.nextTrackUrl) {
      this.nextAudioElement.src = this.nextTrackUrl;
    }
  }

  private _startGaplessHandoff(): void {
    if (this.transitionActive || !this.nextTrackUrl) return;
    this.transitionActive = true;
    this._ensureNextGraph();

    const nextGain = this.nextGainNode!;
    const now = this.attachNativeGraph().context.currentTime;
    nextGain.gain.setValueAtTime(1, now);

    const playPromise = this.nextAudioElement!.play();
    if (playPromise) playPromise.catch(() => { /* autoplay policy */ });

    const duration = this.effectiveDuration(this.audioElement);
    const remainingMs = Math.max(0, (duration - this.audioElement.currentTime) * 1000);
    this.transitionTimer = setTimeout(() => this._completeTransition('gapless'), remainingMs + 20);
  }

  private _startCrossfade(fadeDuration: number): void {
    if (this.transitionActive || !this.nextTrackUrl) return;
    this.transitionActive = true;
    this._ensureNextGraph();

    const ctx = this.attachNativeGraph().context;
    const fade = Math.min(fadeDuration, this.effectiveDuration(this.audioElement) - this.audioElement.currentTime);
    if (fade <= 0) {
      this._startGaplessHandoff();
      return;
    }

    const playPromise = this.nextAudioElement!.play();
    if (playPromise) playPromise.catch(() => { /* autoplay policy */ });

    const startTime = ctx.currentTime;
    const endTime = startTime + fade;

    this.gainNode!.gain.setValueAtTime(this.gainNode!.gain.value, startTime);
    this.gainNode!.gain.linearRampToValueAtTime(0, endTime);
    this.nextGainNode!.gain.setValueAtTime(0, startTime);
    this.nextGainNode!.gain.linearRampToValueAtTime(1, endTime);

    this.transitionTimer = setTimeout(() => this._completeTransition('crossfade'), fade * 1000 + 100);
  }

  private _completeTransition(kind: 'gapless' | 'crossfade'): void {
    if (!this.nextAudioElement || !this.nextGainNode || !this.nextSourceNode) {
      this.transitionActive = false;
      return;
    }

    this._retireElement(this.audioElement);
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    this.audioElement = this.nextAudioElement;
    this.nativeUrl = this.nextTrackUrl;
    this.sourceNode = this.nextSourceNode;
    this.nextSourceNode.disconnect();
    this.nextSourceNode.connect(this.gainNode!);

    this.nextGainNode.disconnect();
    const now = this.attachNativeGraph().context.currentTime;
    this.gainNode!.gain.cancelScheduledValues(now);
    this.gainNode!.gain.setValueAtTime(1, now);

    this.currentTrackDuration = this.nextTrackDuration;
    this.nextAudioElement = null;
    this.nextSourceNode = null;
    this.nextGainNode = null;
    this.nextTrackUrl = null;
    this.nextTrackDuration = null;
    this.transitionActive = false;
    this.setPrebuffering(false);

    this.notifyStateChange();
    try {
      this.onEndedCallback?.({ alreadyPlayingNext: true });
    } catch { /* noop */ }
    void kind;
  }

  private _cancelTransition(): void {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    this.transitionActive = false;
    this.clearPreload();
    // This gain only carries crossfade ramps (volume lives on the context manager):
    // a fade cut short must not leave the next track attenuated.
    if (this.gainNode && this.audioContext) {
      const now = this.audioContext.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(1, now);
    }
  }

  async play(): Promise<void> {
    if (this.activePath === 'native') {
      await this.contextManager.whenRunning();
      await this.audioElement.play();
      this.notifyStateChange();
      return;
    }
    this.workletPlayer?.play();
  }

  pause(): void {
    if (this.activePath === 'native') {
      this.audioElement.pause();
      this.notifyStateChange();
      return;
    }
    this.workletPlayer?.pause();
  }

  stop(): void {
    this._cancelTransition();
    this._abortNativeWaits();
    if (this.activePath === 'native') {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.notifyStateChange();
      return;
    }
    this.workletPlayer?.stop();
  }

  seek(time: number): void {
    if (this.activePath === 'native') {
      const duration = this.effectiveDuration(this.audioElement);
      this.audioElement.currentTime = Math.max(0, Math.min(time, duration > 0 ? duration : 0));
      this.notifyStateChange();
      return;
    }
    this.workletPlayer?.seek(time);
  }

  setVolume(volume: number): void {
    this.contextManager.setVolume(volume);
  }

  setPlaybackRate(rate: number): void {
    const clamped = Math.max(0.25, Math.min(4.0, rate));
    if (this.activePath === 'native') {
      this.audioElement.playbackRate = clamped;
      if (this.nextAudioElement) this.nextAudioElement.playbackRate = clamped;
      return;
    }
    this.workletPlayer?.setPlaybackRate(clamped);
  }

  setEQBandGain(bandIndex: number, gainDb: number): void {
    const gains = this.contextManager.getEQGains();
    gains[bandIndex] = gainDb;
    this.contextManager.setEQGains(gains);
  }

  getEQGains(): number[] {
    return this.contextManager.getEQGains();
  }

  setEQGains(gains: number[]): void {
    this.contextManager.setEQGains(gains);
  }

  setReplayGainLinear(linear: number): void {
    this.contextManager.setReplayGainLinear(linear);
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.contextManager.setReplayGainLimiter(enabled);
  }

  getAnalyser(): AnalyserNode | null {
    return this.contextManager.getAnalyser();
  }

  getCapabilities(): AudioBackendCapabilities {
    if ((this.activePath === 'hifi' || this.activePath === 'buffered') && this.workletPlayer) {
      return this.workletPlayer.getCapabilities();
    }
    return {
      seek: true,
      playbackRate: true,
      gapless: true,
      crossfade: true,
      sinkId: isAudioContextSinkSupported(),
    };
  }

  getState(): AudioPlaybackState {
    if (this.activePath === 'native') {
      const el = this.audioElement;
      const duration = this.effectiveDuration(el);
      return {
        isPlaying: !el.paused && !el.ended,
        currentTime: el.currentTime,
        duration,
        isLoading: false,
        prebufferingNext: this.prebufferingNext,
      };
    }
    const workletState = this.workletPlayer?.getState();
    return workletState ?? {
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isLoading: false,
      prebufferingNext: this.prebufferingNext,
    };
  }

  setNativeOnly(enabled: boolean): void {
    this.nativeOnly = enabled;
  }

  getSyncClock(): SyncClock | null {
    if (this.activePath !== 'native' || !this.nativeUrl) return null;
    // Read through `this` so a gapless handoff (element swap) keeps the clock valid.
    return {
      getSyncPosition: () => this.audioElement.currentTime,
      isSyncPlaying: () => !this.audioElement.paused && !this.audioElement.ended,
      isSyncEnded: () => this.audioElement.ended,
      isSyncSeeking: () =>
        this.audioElement.seeking || this.audioElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      getSyncRate: () => this.audioElement.playbackRate,
    };
  }

  getDecodedPcm(): DecodedPcmView | null {
    if (this.activePath === 'native') return null;
    return this.workletPlayer?.getDecodedPcm() ?? null;
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeGraph();
    this.headerProbeAbort?.abort();
    this._cancelTransition();
    this._abortNativeWaits();
    this._retireElement(this.audioElement);
    this.nativeUrl = null;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.gainNode?.disconnect();
    this.workletPlayer?.destroy();
    this.workletPlayer = null;
  }
}

// Re-export for tests / diagnostics
export { isFlacUrl };
