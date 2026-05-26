// Streaming audio player using HTMLAudioElement + Web Audio API.
// Unlike AudioPlayer (which downloads the full file before playing),
// this player sets the <audio> src directly so the browser handles
// HTTP range requests against Contabo S3, enabling near-instant
// playback start without waiting for the full FLAC to download.
//
// Prerequisites: Contabo bucket CORS must allow GET/HEAD from the
// app origin and expose Accept-Ranges / Content-Length headers.

import { PlayerState } from './audioPlayer';
import { EQChain } from './audio/EQChain';

// Crossfade duration in seconds
const CROSSFADE_DURATION = 3.0;
// How many seconds before track end to start preloading the next track
const PRELOAD_AHEAD_S = 8.0;

export class StreamingAudioPlayer {
  private audioContext: AudioContext;
  // Primary audio element
  private audioElement: HTMLAudioElement;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode;
  private eqChain: EQChain;
  private analyser: AnalyserNode;

  // Secondary audio element used for crossfade / gapless preloading
  private nextAudioElement: HTMLAudioElement | null = null;
  private nextSourceNode: MediaElementAudioSourceNode | null = null;
  private nextGainNode: GainNode | null = null;
  private crossfadeTimer: ReturnType<typeof setInterval> | null = null;
  private crossfadeActive: boolean = false;
  private crossfadeEnabled: boolean = false;
  private nextTrackUrl: string | null = null;

  private onStateChange?: (state: PlayerState) => void;
  private onEndedCallback?: () => void;

  constructor() {
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.eqChain = new EQChain(this.audioContext);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    this.gainNode.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.audioElement = this._makeAudioElement();
  }

  private _makeAudioElement(): HTMLAudioElement {
    const el = new Audio();
    // crossOrigin must be set before src for CORS + Web Audio to work together.
    // If Contabo CORS is not configured, remove this and the analyser will be silent.
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';

    el.addEventListener('timeupdate', () => {
      this.notifyStateChange();
      this._maybeTriggerCrossfade();
    });
    el.addEventListener('play',             () => this.notifyStateChange());
    el.addEventListener('pause',            () => this.notifyStateChange());
    el.addEventListener('durationchange',   () => this.notifyStateChange());
    el.addEventListener('loadedmetadata',   () => this.notifyStateChange());
    el.addEventListener('ended', () => {
      this.notifyStateChange();
      if (!this.crossfadeActive) {
        try { this.onEndedCallback?.(); } catch { /* noop */ }
      }
    });
    return el;
  }

  setStateChangeCallback(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: () => void): void {
    this.onEndedCallback = callback;
  }

  private notifyStateChange(): void {
    this.onStateChange?.(this.getState());
  }

  // Set the audio source and wait until the browser has enough data to begin
  // playback (the `canplay` event). With HTTP range requests this typically
  // fires within 1-3 seconds even for large FLAC files.
  async loadURL(url: string): Promise<void> {
    // MediaElementAudioSourceNode can only be created once per element.
    // Changing audioElement.src reuses the existing node automatically.
    if (!this.sourceNode) {
      this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);
      this.sourceNode.connect(this.gainNode);
    }

    this._cancelCrossfade();
    this.audioElement.src = url;
    this.audioElement.load();

    return new Promise<void>((resolve, reject) => {
      const onCanPlay = () => { cleanup(); resolve(); };
      const onError   = () => { cleanup(); reject(new Error(`Failed to load audio: ${url}`)); };
      const cleanup   = () => {
        this.audioElement.removeEventListener('canplay', onCanPlay);
        this.audioElement.removeEventListener('error',   onError);
      };
      this.audioElement.addEventListener('canplay', onCanPlay);
      this.audioElement.addEventListener('error',   onError);
    });
  }

  /**
   * Pre-buffer the next track URL so crossfade can start without a loading delay.
   * Call this when the next track is known (e.g. when queue advances).
   */
  preloadNext(url: string): void {
    this.nextTrackUrl = url;
    // Use the factory so the element has CORS config and event listeners already attached
    if (!this.nextAudioElement) {
      this.nextAudioElement = this._makeAudioElement();
    }
    if (this.nextAudioElement.src !== url) {
      this.nextAudioElement.src = url;
      this.nextAudioElement.load();
    }
  }

  /**
   * Enable or disable crossfade between tracks.
   */
  setCrossfadeEnabled(enabled: boolean): void {
    this.crossfadeEnabled = enabled;
    if (!enabled) this._cancelCrossfade();
  }

  private _maybeTriggerCrossfade(): void {
    if (!this.crossfadeEnabled) return;
    if (this.crossfadeActive) return;
    if (!this.nextTrackUrl) return;

    const el = this.audioElement;
    const remaining = el.duration - el.currentTime;
    if (!isFinite(remaining) || remaining > PRELOAD_AHEAD_S) return;

    // Start crossfade when within CROSSFADE_DURATION seconds of end
    if (remaining <= CROSSFADE_DURATION && remaining > 0) {
      this._startCrossfade();
    }
  }

  private _startCrossfade(): void {
    if (this.crossfadeActive || !this.nextTrackUrl) return;
    this.crossfadeActive = true;

    const ctx = this.audioContext;
    const fadeDuration = Math.min(CROSSFADE_DURATION, this.audioElement.duration - this.audioElement.currentTime);

    // Set up next element — use factory for consistent CORS + event listener config
    if (!this.nextAudioElement) {
      this.nextAudioElement = this._makeAudioElement();
      this.nextAudioElement.src = this.nextTrackUrl;
    }

    if (!this.nextSourceNode) {
      this.nextGainNode = ctx.createGain();
      this.nextGainNode.gain.value = 0;
      this.nextGainNode.connect(this.eqChain.input);
      this.nextSourceNode = ctx.createMediaElementSource(this.nextAudioElement);
      this.nextSourceNode.connect(this.nextGainNode);
    }

    // Start next track silently
    const playPromise = this.nextAudioElement.play();
    if (playPromise) playPromise.catch(() => { /* autoplay policy */ });

    const startTime = ctx.currentTime;
    const endTime = startTime + fadeDuration;

    // Fade out primary
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, startTime);
    this.gainNode.gain.linearRampToValueAtTime(0, endTime);

    // Fade in next
    this.nextGainNode!.gain.setValueAtTime(0, startTime);
    this.nextGainNode!.gain.linearRampToValueAtTime(1, endTime);

    // After crossfade completes, swap elements
    this.crossfadeTimer = setTimeout(() => {
      this._completeCrossfade();
    }, fadeDuration * 1000 + 100);
  }

  private _completeCrossfade(): void {
    if (!this.nextAudioElement || !this.nextGainNode || !this.nextSourceNode) {
      this.crossfadeActive = false;
      return;
    }

    // Stop old element
    this.audioElement.pause();
    this.audioElement.src = '';
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    // Promote next → current
    this.audioElement = this.nextAudioElement;
    this.sourceNode   = this.nextSourceNode;

    // Reconnect: currently nextSourceNode → nextGainNode → eqChain
    // We need sourceNode → gainNode → eqChain
    // Disconnect nextSourceNode from nextGainNode, reconnect to gainNode
    this.nextSourceNode.disconnect();
    this.nextSourceNode.connect(this.gainNode);

    this.nextGainNode.disconnect();
    const now = this.audioContext.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(1, now);

    this.nextAudioElement = null;
    this.nextSourceNode   = null;
    this.nextGainNode     = null;
    this.nextTrackUrl     = null;
    this.crossfadeActive  = false;

    // The promoted element already has listeners from _makeAudioElement(); no re-attachment needed.
    this.notifyStateChange();
    // Notify queue so it can advance to the next track internally
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
    if (this.nextGainNode)   { try { this.nextGainNode.disconnect(); }   catch { /**/ } this.nextGainNode   = null; }
    this.nextTrackUrl = null;
    // Restore primary gain — cancel only future-scheduled values, not past ones
    const now = this.audioContext.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
  }

  async play(): Promise<void> {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    await this.audioElement.play();
    this.notifyStateChange();
  }

  pause(): void {
    this.audioElement.pause();
    this.notifyStateChange();
  }

  stop(): void {
    this._cancelCrossfade();
    this.audioElement.pause();
    this.audioElement.currentTime = 0;
    this.notifyStateChange();
  }

  seek(time: number): void {
    const duration = this.audioElement.duration;
    this.audioElement.currentTime = Math.max(0, Math.min(time, isFinite(duration) ? duration : 0));
    this.notifyStateChange();
  }

  setVolume(volume: number): void {
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }

  setPlaybackRate(rate: number): void {
    const clamped = Math.max(0.25, Math.min(4.0, rate));
    this.audioElement.playbackRate = clamped;
    if (this.nextAudioElement) {
      this.nextAudioElement.playbackRate = clamped;
    }
  }

  setEQBandGain(bandIndex: number, gainDb: number): void {
    this.eqChain.setBandGain(bandIndex, gainDb);
  }

  getEQGains(): number[] {
    return this.eqChain.getAllGains();
  }

  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  // isLoading is managed externally by loadAudioFromUrl in Player.tsx;
  // we return false here so it doesn't fight with that state.
  getState(): PlayerState {
    const el = this.audioElement;
    return {
      isPlaying: !el.paused && !el.ended,
      currentTime: el.currentTime,
      duration: isFinite(el.duration) ? el.duration : 0,
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
    this.eqChain.disconnect();
    this.analyser.disconnect();
    this.audioContext.close();
  }
}
