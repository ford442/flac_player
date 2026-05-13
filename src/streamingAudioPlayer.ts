// Streaming audio player using HTMLAudioElement + Web Audio API.
// Unlike AudioPlayer (which downloads the full file before playing),
// this player sets the <audio> src directly so the browser handles
// HTTP range requests against Contabo S3, enabling near-instant
// playback start without waiting for the full FLAC to download.
//
// Prerequisites: Contabo bucket CORS must allow GET/HEAD from the
// app origin and expose Accept-Ranges / Content-Length headers.

import { PlayerState } from './audioPlayer';

export class StreamingAudioPlayer {
  private audioContext: AudioContext;
  private audioElement: HTMLAudioElement;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode;
  private analyser: AnalyserNode;
  private onStateChange?: (state: PlayerState) => void;
  private onEndedCallback?: () => void;

  constructor() {
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.audioElement = new Audio();
    // crossOrigin must be set before src for CORS + Web Audio to work together.
    // If Contabo CORS is not configured, remove this and the analyser will be silent.
    this.audioElement.crossOrigin = 'anonymous';
    this.audioElement.preload = 'auto';

    this.audioElement.addEventListener('timeupdate', () => this.notifyStateChange());
    this.audioElement.addEventListener('play',        () => this.notifyStateChange());
    this.audioElement.addEventListener('pause',       () => this.notifyStateChange());
    this.audioElement.addEventListener('durationchange', () => this.notifyStateChange());
    this.audioElement.addEventListener('loadedmetadata', () => this.notifyStateChange());
    this.audioElement.addEventListener('ended', () => {
      this.notifyStateChange();
      try { this.onEndedCallback?.(); } catch { /* noop */ }
    });
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
    this.audioElement.pause();
    this.audioElement.src = '';
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.gainNode.disconnect();
    this.analyser.disconnect();
    this.audioContext.close();
  }
}
