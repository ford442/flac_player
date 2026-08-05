// Streaming audio player — hi-fi WASM FLAC streaming (primary) with native <audio> fallback.
//
// Hi-Fi path:  HTTP Range → StreamingDecoder → AudioWorklet ring buffer → Analyser
// Native path: <audio> element (WAV/MP3 or when WASM/worklet unavailable)
//
// Gapless / crossfade is implemented on the native <audio> path (dual elements).

import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import { WorkletAudioPlayer } from './WorkletAudioPlayer';
import { probeRemoteAudio } from '../../utils/rangeFetch';
import { probeRemoteAudioDuration } from '../../utils/audioHeader';
import {
  describePlaybackPath,
  isFlacUrl,
  selectDecodeStrategy,
  type PlaybackPathInfo,
} from '../../utils/playbackPath';
import { isTrackCached, getOrFetchTrack } from '../../storage/trackCache';
import type { AudioPlaybackState } from '../../types/audio';
import {
  DEFAULT_GAPLESS_MODE,
  DEFAULT_CROSSFADE_MS,
  PRELOAD_AHEAD_S,
  isGaplessActive,
  overlapSeconds,
  type GaplessSettings,
  type PreloadNextOptions,
  type TrackTransitionEvent,
} from '../../types/gapless';
import { BaseAudioBackend } from './BaseAudioBackend';

/** Lead time (seconds) to start the next native element before the measured end. */
const GAPLESS_SCHEDULE_LEAD_S = 0.05;

type ActivePath = 'native' | 'hifi' | 'buffered';

function normalizePreloadOptions(options: PreloadNextOptions | string): PreloadNextOptions {
  return typeof options === 'string' ? { url: options } : options;
}

export class StreamingAudioPlayer extends BaseAudioBackend {
  private audioContext: AudioContext;
  private gainNode: GainNode;
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

  private onPCMBlock?: (buffer: Float32Array, channels: number, sampleRate: number) => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    super();
    this.audioContext = contextManager.getContext();
    this.gainNode = this.audioContext.createGain();
    contextManager.connectInput(this.gainNode);
    this.audioElement = this._makeAudioElement();
  }

  async initialize(): Promise<void> {
    if (!this.workletPlayer) {
      this.workletPlayer = new WorkletAudioPlayer(this.contextManager);
      this.workletPlayer.setStateChangeCallback((state) => this.notifyStateChange(state));
      this.workletPlayer.setOnEndedCallback((event) => this.onEndedCallback?.(event));
      if (this.onPCMBlock) {
        this.workletPlayer.setPCMCallback(this.onPCMBlock);
      }
      await this.workletPlayer.initialize();
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

    el.addEventListener('timeupdate', () => {
      this.notifyStateChange();
      this._maybeTriggerTransition();
    });
    el.addEventListener('play', () => this.notifyStateChange());
    el.addEventListener('pause', () => this.notifyStateChange());
    el.addEventListener('durationchange', () => this.notifyStateChange());
    el.addEventListener('loadedmetadata', () => this.notifyStateChange());
    el.addEventListener('ended', () => {
      this.notifyStateChange();
      if (!this.transitionActive) {
        try { this.onEndedCallback?.(); } catch { /* noop */ }
      }
    });
    return el;
  }

  override setOnEndedCallback(callback?: (event?: TrackTransitionEvent) => void): void {
    super.setOnEndedCallback(callback);
    this.workletPlayer?.setOnEndedCallback(callback);
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
    await this.initialize();
    this._cancelTransition();
    this.currentTrackDuration = options.expectedDuration && options.expectedDuration > 0
      ? options.expectedDuration
      : null;

    if (isGaplessActive(this.gaplessSettings)) {
      void this._refineDurationFromHeader(url);
    }

    let probe;
    try {
      probe = await probeRemoteAudio(url);
    } catch {
      probe = { url, contentLength: null, acceptsRanges: false, contentType: null };
    }

    const strategy = selectDecodeStrategy(probe.contentLength, { outputMode: 'streaming', url });

    if (strategy === 'native-stream') {
      this.activePath = 'native';
      return this._loadNative(url);
    }

    if (strategy === 'buffered') {
      this.activePath = 'buffered';
      return this._loadBuffered(url, options.expectedDuration);
    }

    this.activePath = 'hifi';
    return this._loadHifi(url, options.expectedDuration);
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

  private async _loadHifi(url: string, expectedDuration?: number): Promise<void> {
    const cached = await isTrackCached(url);
    let cachedResponse: Response | undefined;
    if (cached) {
      const response = await getOrFetchTrack(url);
      cachedResponse = response;
    }

    await this.workletPlayer!.loadFromURLStreaming(url, {
      expectedDuration,
      cachedResponse,
    });
    this.workletPlayer?.setGaplessSettings(this.gaplessSettings);
    this.notifyStateChange();
  }

  private async _loadBuffered(url: string, expectedDuration?: number): Promise<void> {
    const response = await getOrFetchTrack(url);
    const buffer = await response.arrayBuffer();
    await this.workletPlayer!.loadFromArrayBuffer(buffer);
    this.workletPlayer?.setGaplessSettings(this.gaplessSettings);
    if (expectedDuration && expectedDuration > 0) {
      // Duration is set by decoder; metadata from library is informational only
    }
    this.notifyStateChange();
  }

  private async _loadNative(url: string): Promise<void> {
    if (!this.sourceNode) {
      this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);
      this.sourceNode.connect(this.gainNode);
    }

    this.audioElement.src = url;
    this.audioElement.load();

    return new Promise<void>((resolve, reject) => {
      const onCanPlay = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`Failed to load audio: ${url}`)); };
      const cleanup = () => {
        this.audioElement.removeEventListener('canplay', onCanPlay);
        this.audioElement.removeEventListener('error', onError);
      };
      this.audioElement.addEventListener('canplay', onCanPlay);
      this.audioElement.addEventListener('error', onError);
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
    this.nextTrackUrl = null;
    this.nextTrackDuration = null;
    this.setPrebuffering(false);
    if (this.nextAudioElement) {
      this.nextAudioElement.pause();
      this.nextAudioElement.src = '';
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
    this.workletPlayer?.clearPreload?.();
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

    if (!this.nextSourceNode) {
      this.nextGainNode = this.audioContext.createGain();
      this.nextGainNode.gain.value = 0;
      this.contextManager.connectInput(this.nextGainNode);
      this.nextSourceNode = this.audioContext.createMediaElementSource(this.nextAudioElement);
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
    const now = this.audioContext.currentTime;
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

    const ctx = this.audioContext;
    const fade = Math.min(fadeDuration, this.effectiveDuration(this.audioElement) - this.audioElement.currentTime);
    if (fade <= 0) {
      this._startGaplessHandoff();
      return;
    }

    const playPromise = this.nextAudioElement!.play();
    if (playPromise) playPromise.catch(() => { /* autoplay policy */ });

    const startTime = ctx.currentTime;
    const endTime = startTime + fade;

    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, startTime);
    this.gainNode.gain.linearRampToValueAtTime(0, endTime);
    this.nextGainNode!.gain.setValueAtTime(0, startTime);
    this.nextGainNode!.gain.linearRampToValueAtTime(1, endTime);

    this.transitionTimer = setTimeout(() => this._completeTransition('crossfade'), fade * 1000 + 100);
  }

  private _completeTransition(kind: 'gapless' | 'crossfade'): void {
    if (!this.nextAudioElement || !this.nextGainNode || !this.nextSourceNode) {
      this.transitionActive = false;
      return;
    }

    this.audioElement.pause();
    this.audioElement.src = '';
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    this.audioElement = this.nextAudioElement;
    this.sourceNode = this.nextSourceNode;
    this.nextSourceNode.disconnect();
    this.nextSourceNode.connect(this.gainNode);

    this.nextGainNode.disconnect();
    const now = this.audioContext.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(1, now);

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
    const now = this.audioContext.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
  }

  async play(): Promise<void> {
    if (this.activePath === 'native') {
      if (this.audioContext.state === 'suspended') await this.contextManager.resume();
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

  getAnalyser(): AnalyserNode {
    return this.contextManager.getAnalyser();
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

  destroy(): void {
    this.destroyed = true;
    this.headerProbeAbort?.abort();
    this._cancelTransition();
    this.audioElement.pause();
    this.audioElement.src = '';
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.gainNode.disconnect();
    this.workletPlayer?.destroy();
    this.workletPlayer = null;
  }
}

// Re-export for tests / diagnostics
export { isFlacUrl };
