// Audio player with load/play/pause/seek functionality and gapless queue scheduling.
import { decodeAudioWithBuffer } from './audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from './audio/AudioContextManager';
import { getOrFetchTrack } from './storage/trackCache';
import type { AudioBackend, AudioPlaybackState } from './types/audio';
import {
  DEFAULT_CROSSFADE_MS,
  DEFAULT_GAPLESS_MODE,
  isGaplessActive,
  overlapSeconds,
  type GaplessSettings,
  type PreloadNextOptions,
  type TrackTransitionEvent,
} from './types/gapless';

export type { AudioPlaybackState } from './types/audio';

const GAPLESS_SCHEDULE_LEAD_S = 0.05;

export class AudioPlayer implements AudioBackend {
  private audioContext: AudioContext;
  private sourceNode: AudioBufferSourceNode | null = null;
  private nextSourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode;
  private crossfadeGainNode: GainNode | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private nextAudioBuffer: AudioBuffer | null = null;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private rateAtPause: number = 1.0;
  private isPlaying: boolean = false;
  private playbackRate: number = 1.0;
  private gaplessSettings: GaplessSettings = {
    mode: DEFAULT_GAPLESS_MODE,
    crossfadeMs: DEFAULT_CROSSFADE_MS,
  };
  private prebufferingNext = false;
  private preloadAbort: AbortController | null = null;
  private nextScheduled = false;
  private segmentTransitionFired = false;
  private onStateChange?: (state: AudioPlaybackState) => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    this.audioContext = contextManager.getContext();
    this.gainNode = this.audioContext.createGain();
    contextManager.connectInput(this.gainNode);
  }

  async initialize(): Promise<void> { /* graph is initialized by the manager */ }

  private onEndedCallback?: (event?: TrackTransitionEvent) => void;

  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: (event?: TrackTransitionEvent) => void): void {
    this.onEndedCallback = callback;
  }

  private setPrebuffering(active: boolean): void {
    if (this.prebufferingNext === active) return;
    this.prebufferingNext = active;
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  setGaplessSettings(settings: GaplessSettings): void {
    this.gaplessSettings = settings;
    if (!isGaplessActive(settings)) this.clearPreload();
  }

  setCrossfadeEnabled(enabled: boolean): void {
    this.setGaplessSettings({
      mode: enabled ? 'crossfade' : 'off',
      crossfadeMs: this.gaplessSettings.crossfadeMs,
    });
  }

  preloadNext(options: PreloadNextOptions | string): void {
    if (!isGaplessActive(this.gaplessSettings)) return;
    const { url } = typeof options === 'string' ? { url: options } : options;
    this.preloadAbort?.abort();
    const controller = new AbortController();
    this.preloadAbort = controller;
    this.setPrebuffering(true);

    void (async () => {
      try {
        const response = await getOrFetchTrack(url);
        if (controller.signal.aborted) return;
        const arrayBuffer = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        const { decoderResult, audioBuffer: nativeBuffer } = await decodeAudioWithBuffer(
          arrayBuffer,
          this.audioContext,
          undefined
        );
        if (controller.signal.aborted) return;

        if (nativeBuffer) {
          this.nextAudioBuffer = nativeBuffer;
        } else {
          const frameCount = decoderResult.interleavedBuffer.length / decoderResult.channels;
          const buffer = this.audioContext.createBuffer(
            decoderResult.channels,
            frameCount,
            decoderResult.sampleRate
          );
          const interleaved = decoderResult.interleavedBuffer;
          for (let ch = 0; ch < decoderResult.channels; ch++) {
            const channelData = buffer.getChannelData(ch);
            for (let i = 0, idx = ch; i < frameCount; i++, idx += decoderResult.channels) {
              channelData[i] = interleaved[idx];
            }
          }
          this.nextAudioBuffer = buffer;
        }

        if (this.isPlaying) {
          this._scheduleNextIfNeeded();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn('[AudioPlayer] preloadNext failed:', err);
        }
      } finally {
        if (!controller.signal.aborted) this.setPrebuffering(false);
      }
    })();
  }

  clearPreload(): void {
    this.preloadAbort?.abort();
    this.preloadAbort = null;
    this.nextAudioBuffer = null;
    this.nextScheduled = false;
    this.segmentTransitionFired = false;
    this.setPrebuffering(false);
    if (this.nextSourceNode) {
      try { this.nextSourceNode.stop(); } catch { /**/ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }
    if (this.crossfadeGainNode) {
      this.crossfadeGainNode.disconnect();
      this.crossfadeGainNode = null;
    }
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    this.notifyStateChange();

    try {
      this.stop();
      this.clearPreload();

      const { decoderResult, audioBuffer: nativeBuffer } = await decodeAudioWithBuffer(
        arrayBuffer,
        this.audioContext,
        filename
      );

      if (nativeBuffer) {
        this.audioBuffer = nativeBuffer;
      } else {
        const frameCount = decoderResult.interleavedBuffer.length / decoderResult.channels;
        this.audioBuffer = this.audioContext.createBuffer(
          decoderResult.channels,
          frameCount,
          decoderResult.sampleRate
        );

        const interleaved = decoderResult.interleavedBuffer;
        for (let ch = 0; ch < decoderResult.channels; ch++) {
          const channelData = this.audioBuffer.getChannelData(ch);
          for (let i = 0, idx = ch; i < frameCount; i++, idx += decoderResult.channels) {
            channelData[i] = interleaved[idx];
          }
        }
      }

      this.pausedAt = 0;
      this.notifyStateChange();
    } catch (error) {
      console.error('Error loading audio:', error);
      throw error;
    }
  }

  loadFromArrayBuffer(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    return this.loadAudio(arrayBuffer, filename);
  }

  private _scheduleNextIfNeeded(): void {
    if (!this.isPlaying || !this.audioBuffer || !this.nextAudioBuffer || this.nextScheduled) return;

    const overlap = overlapSeconds(this.gaplessSettings);
    const lead = overlap > 0 ? overlap : GAPLESS_SCHEDULE_LEAD_S;
    const currentPos = this.getCurrentTime();
    const remaining = this.audioBuffer.duration - currentPos;
    if (remaining > lead + 0.25) return;

    const when = this.audioContext.currentTime + Math.max(0, remaining - (overlap > 0 ? overlap : 0));
    this._scheduleNextAt(when, overlap);
  }

  private _scheduleNextAt(when: number, overlap: number): void {
    if (!this.nextAudioBuffer || this.nextScheduled) return;
    this.nextScheduled = true;

    const nextSource = this.audioContext.createBufferSource();
    nextSource.buffer = this.nextAudioBuffer;
    nextSource.playbackRate.value = this.playbackRate;

    if (overlap > 0) {
      if (!this.crossfadeGainNode) {
        this.crossfadeGainNode = this.audioContext.createGain();
        this.contextManager.connectInput(this.crossfadeGainNode);
      }
      nextSource.connect(this.crossfadeGainNode);
      const end = when + overlap;
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, when);
      this.gainNode.gain.linearRampToValueAtTime(0, end);
      this.crossfadeGainNode.gain.setValueAtTime(0, when);
      this.crossfadeGainNode.gain.linearRampToValueAtTime(1, end);
    } else {
      nextSource.connect(this.gainNode);
    }

    nextSource.onended = () => {
      if (!this.segmentTransitionFired) return;
      this.isPlaying = false;
      this.pausedAt = 0;
      this.notifyStateChange();
      if (this.onEndedCallback) {
        try { this.onEndedCallback(); } catch (err) { console.warn('onEnded callback threw', err); }
      }
    };

    nextSource.start(when);
    this.nextSourceNode = nextSource;

    const swapAt = overlap > 0 ? when + overlap : when;
    window.setTimeout(() => {
      if (!this.nextAudioBuffer) return;
      this.segmentTransitionFired = true;
      if (this.sourceNode) {
        try { this.sourceNode.stop(); } catch { /**/ }
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }
      this.audioBuffer = this.nextAudioBuffer;
      this.nextAudioBuffer = null;
      this.nextScheduled = false;
      this.pausedAt = 0;
      this.startTime = this.audioContext.currentTime;
      this.sourceNode = nextSource;
      if (this.crossfadeGainNode) {
        nextSource.disconnect();
        nextSource.connect(this.gainNode);
        this.crossfadeGainNode.disconnect();
        this.crossfadeGainNode = null;
        const now = this.audioContext.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(1, now);
      }
      this.notifyStateChange();
      if (this.onEndedCallback) {
        try { this.onEndedCallback({ alreadyPlayingNext: true }); } catch (err) { console.warn('onEnded callback threw', err); }
      }
    }, Math.max(0, (swapAt - this.audioContext.currentTime) * 1000));
  }

  play(): void {
    if (!this.audioBuffer) {
      console.error('No audio loaded');
      return;
    }

    if (this.isPlaying) {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      void this.contextManager.resume();
    }

    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.gainNode);
    this.segmentTransitionFired = false;

    this.sourceNode.onended = () => {
      if (this.segmentTransitionFired) return;
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pausedAt = 0;
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded callback threw', err); }
        }
      }
    };

    this.sourceNode.playbackRate.value = this.playbackRate;
    this.startTime = this.audioContext.currentTime - this.pausedAt / this.playbackRate;
    this.sourceNode.start(0, this.pausedAt);
    this.isPlaying = true;
    this.notifyStateChange();

    if (isGaplessActive(this.gaplessSettings) && this.nextAudioBuffer) {
      const overlap = overlapSeconds(this.gaplessSettings);
      const remaining = this.audioBuffer.duration - this.pausedAt;
      const when = this.audioContext.currentTime + Math.max(0, remaining - (overlap > 0 ? overlap : GAPLESS_SCHEDULE_LEAD_S));
      this._scheduleNextAt(when, overlap);
    }
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode) {
      return;
    }

    this.rateAtPause = this.playbackRate;
    this.pausedAt = (this.audioContext.currentTime - this.startTime) * this.rateAtPause;

    this.sourceNode.stop();
    this.sourceNode.disconnect();
    this.sourceNode = null;
    if (this.nextSourceNode) {
      try { this.nextSourceNode.stop(); } catch { /**/ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }
    this.nextScheduled = false;

    this.isPlaying = false;
    this.notifyStateChange();
  }

  stop(): void {
    if (this.sourceNode) {
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.nextSourceNode) {
      try { this.nextSourceNode.stop(); } catch { /**/ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }

    this.isPlaying = false;
    this.pausedAt = 0;
    this.startTime = 0;
    this.nextScheduled = false;
    this.segmentTransitionFired = false;
    this.notifyStateChange();
  }

  seek(time: number): void {
    if (!this.audioBuffer) {
      return;
    }

    const wasPlaying = this.isPlaying;

    if (this.isPlaying) {
      this.pause();
    }

    this.pausedAt = Math.max(0, Math.min(time, this.audioBuffer.duration));

    if (wasPlaying) {
      this.play();
    }

    this.notifyStateChange();
  }

  getCurrentTime(): number {
    if (!this.audioBuffer) {
      return 0;
    }

    if (this.isPlaying) {
      return Math.min(
        (this.audioContext.currentTime - this.startTime) * this.playbackRate,
        this.audioBuffer.duration
      );
    }

    return this.pausedAt;
  }

  getDuration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  getState(): AudioPlaybackState {
    return {
      isPlaying: this.isPlaying,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      isLoading: false,
      prebufferingNext: this.prebufferingNext,
    };
  }

  setVolume(volume: number): void {
    this.contextManager.setVolume(volume);
  }

  setPlaybackRate(rate: number): void {
    const clampedRate = Math.max(0.25, Math.min(4.0, rate));
    if (this.isPlaying && this.sourceNode) {
      const currentPos = this.getCurrentTime();
      this.playbackRate = clampedRate;
      this.sourceNode.playbackRate.value = clampedRate;
      this.startTime = this.audioContext.currentTime - currentPos / clampedRate;
    } else {
      this.playbackRate = clampedRate;
    }
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

  destroy(): void {
    this.clearPreload();
    this.stop();
    this.gainNode.disconnect();
  }
}
