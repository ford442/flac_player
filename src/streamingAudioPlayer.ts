// Streaming audio player — hi-fi WASM FLAC streaming (primary) with native <audio> fallback.
//
// Hi-Fi path:  HTTP Range → StreamingDecoder → AudioWorklet ring buffer → Analyser
// Native path: <audio> element (WAV/MP3 or when WASM/worklet unavailable)
//
// Prerequisites for native path: CORS + Accept-Ranges on the audio host.

import { AudioContextManager, sharedAudioContextManager } from './audio/AudioContextManager';
import { AudioWorkletPlayer } from './audioWorkletPlayer';
import { probeRemoteAudio } from './utils/rangeFetch';
import {
  describePlaybackPath,
  isFlacUrl,
  selectDecodeStrategy,
  type PlaybackPathInfo,
} from './utils/playbackPath';
import { isTrackCached, getOrFetchTrack } from './storage/trackCache';
import type { AudioBackend, AudioPlaybackState } from './types/audio';

const CROSSFADE_DURATION = 3.0;
const PRELOAD_AHEAD_S = 8.0;

type ActivePath = 'native' | 'hifi' | 'buffered';

export class StreamingAudioPlayer implements AudioBackend {
  private audioContext: AudioContext;
  private gainNode: GainNode;
  private workletPlayer: AudioWorkletPlayer | null = null;
  private activePath: ActivePath | null = null;

  // Native <audio> path
  private audioElement: HTMLAudioElement;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private nextAudioElement: HTMLAudioElement | null = null;
  private nextSourceNode: MediaElementAudioSourceNode | null = null;
  private nextGainNode: GainNode | null = null;
  private crossfadeTimer: ReturnType<typeof setInterval> | null = null;
  private crossfadeActive = false;
  private crossfadeEnabled = false;
  private nextTrackUrl: string | null = null;

  private onStateChange?: (state: AudioPlaybackState) => void;
  private onEndedCallback?: () => void;
  private onPCMBlock?: (buffer: Float32Array, channels: number, sampleRate: number) => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    this.audioContext = contextManager.getContext();
    this.gainNode = this.audioContext.createGain();
    contextManager.connectInput(this.gainNode);
    this.audioElement = this._makeAudioElement();
  }

  async initialize(): Promise<void> {
    if (!this.workletPlayer) {
      this.workletPlayer = new AudioWorkletPlayer(this.contextManager);
      this.workletPlayer.setStateChangeCallback((state) => this.notifyStateChange(state));
      this.workletPlayer.setOnEndedCallback(() => this.onEndedCallback?.());
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
      this._maybeTriggerCrossfade();
    });
    el.addEventListener('play', () => this.notifyStateChange());
    el.addEventListener('pause', () => this.notifyStateChange());
    el.addEventListener('durationchange', () => this.notifyStateChange());
    el.addEventListener('loadedmetadata', () => this.notifyStateChange());
    el.addEventListener('ended', () => {
      this.notifyStateChange();
      if (!this.crossfadeActive) {
        try { this.onEndedCallback?.(); } catch { /* noop */ }
      }
    });
    return el;
  }

  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: () => void): void {
    this.onEndedCallback = callback;
    this.workletPlayer?.setOnEndedCallback(callback);
  }

  private notifyStateChange(override?: AudioPlaybackState): void {
    this.onStateChange?.(override ?? this.getState());
  }

  async loadFromURL(
    url: string,
    options: { expectedDuration?: number } = {}
  ): Promise<void> {
    await this.initialize();
    this._cancelCrossfade();

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
    this.notifyStateChange();
  }

  private async _loadBuffered(url: string, expectedDuration?: number): Promise<void> {
    const response = await getOrFetchTrack(url);
    const buffer = await response.arrayBuffer();
    await this.workletPlayer!.loadFromArrayBuffer(buffer);
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

  preloadNext(url: string): void {
    if (this.activePath !== 'native') return;
    this.nextTrackUrl = url;
    if (!this.nextAudioElement) {
      this.nextAudioElement = this._makeAudioElement();
    }
    if (this.nextAudioElement.src !== url) {
      this.nextAudioElement.src = url;
      this.nextAudioElement.load();
    }
  }

  setCrossfadeEnabled(enabled: boolean): void {
    this.crossfadeEnabled = enabled;
    if (!enabled) this._cancelCrossfade();
  }

  private _maybeTriggerCrossfade(): void {
    if (this.activePath !== 'native') return;
    if (!this.crossfadeEnabled || this.crossfadeActive || !this.nextTrackUrl) return;

    const el = this.audioElement;
    const remaining = el.duration - el.currentTime;
    if (!isFinite(remaining) || remaining > PRELOAD_AHEAD_S) return;
    if (remaining <= CROSSFADE_DURATION && remaining > 0) {
      this._startCrossfade();
    }
  }

  private _startCrossfade(): void {
    if (this.crossfadeActive || !this.nextTrackUrl) return;
    this.crossfadeActive = true;

    const ctx = this.audioContext;
    const fadeDuration = Math.min(CROSSFADE_DURATION, this.audioElement.duration - this.audioElement.currentTime);

    if (!this.nextAudioElement) {
      this.nextAudioElement = this._makeAudioElement();
      this.nextAudioElement.src = this.nextTrackUrl;
    }

    if (!this.nextSourceNode) {
      this.nextGainNode = ctx.createGain();
      this.nextGainNode.gain.value = 0;
      this.contextManager.connectInput(this.nextGainNode);
      this.nextSourceNode = ctx.createMediaElementSource(this.nextAudioElement);
      this.nextSourceNode.connect(this.nextGainNode);
    }

    const playPromise = this.nextAudioElement.play();
    if (playPromise) playPromise.catch(() => { /* autoplay policy */ });

    const startTime = ctx.currentTime;
    const endTime = startTime + fadeDuration;

    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, startTime);
    this.gainNode.gain.linearRampToValueAtTime(0, endTime);
    this.nextGainNode!.gain.setValueAtTime(0, startTime);
    this.nextGainNode!.gain.linearRampToValueAtTime(1, endTime);

    this.crossfadeTimer = setTimeout(() => this._completeCrossfade(), fadeDuration * 1000 + 100);
  }

  private _completeCrossfade(): void {
    if (!this.nextAudioElement || !this.nextGainNode || !this.nextSourceNode) {
      this.crossfadeActive = false;
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

    this.nextAudioElement = null;
    this.nextSourceNode = null;
    this.nextGainNode = null;
    this.nextTrackUrl = null;
    this.crossfadeActive = false;

    this.notifyStateChange();
    try { this.onEndedCallback?.(); } catch { /* noop */ }
  }

  private _cancelCrossfade(): void {
    if (this.crossfadeTimer !== null) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
    this.crossfadeActive = false;
    if (this.nextAudioElement) {
      this.nextAudioElement.pause();
      this.nextAudioElement.src = '';
      this.nextAudioElement = null;
    }
    if (this.nextSourceNode) { try { this.nextSourceNode.disconnect(); } catch { /**/ } this.nextSourceNode = null; }
    if (this.nextGainNode) { try { this.nextGainNode.disconnect(); } catch { /**/ } this.nextGainNode = null; }
    this.nextTrackUrl = null;
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
    this._cancelCrossfade();
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
      const duration = this.audioElement.duration;
      this.audioElement.currentTime = Math.max(0, Math.min(time, isFinite(duration) ? duration : 0));
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

  getAnalyser(): AnalyserNode {
    return this.contextManager.getAnalyser();
  }

  getState(): AudioPlaybackState {
    if (this.activePath === 'native') {
      const el = this.audioElement;
      return {
        isPlaying: !el.paused && !el.ended,
        currentTime: el.currentTime,
        duration: isFinite(el.duration) ? el.duration : 0,
        isLoading: false,
      };
    }
    return this.workletPlayer?.getState() ?? {
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isLoading: false,
    };
  }

  destroy(): void {
    this._cancelCrossfade();
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
