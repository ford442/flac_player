// Buffered Web Audio API player with gapless queue scheduling.
import { decodeAudioWithBuffer } from '../../audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import { ensureContextForBuffer } from '../ensureContextForSource';
import { getOrFetchTrack } from '../../storage/trackCache';
import type { AudioPlaybackState, DecodedPcmView } from '../../types/audio';
import {
  DEFAULT_CROSSFADE_MS,
  DEFAULT_GAPLESS_MODE,
  isGaplessActive,
  overlapSeconds,
  type GaplessSettings,
  type PreloadNextOptions,
} from '../../types/gapless';
import { BaseAudioBackend } from './BaseAudioBackend';

export type { AudioPlaybackState } from '../../types/audio';

const GAPLESS_SCHEDULE_LEAD_S = 0.05;

export class WebAudioPlayer extends BaseAudioBackend {
  private audioContext: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private nextSourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
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
  private readonly unsubscribeGraph: () => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    super();
    this.unsubscribeGraph = contextManager.subscribeGraphRecreated(() => {
      this.sourceNode = null;
      this.nextSourceNode = null;
      this.crossfadeGainNode = null;
      this.gainNode = null;
      this.audioContext = null;
    });
  }

  async initialize(): Promise<void> {
    /* Context is created in loadAudio via ensureForTrack (native file rate). */
  }

  private attachGraph(): AudioContext {
    const ctx = this.contextManager.getContext();
    if (this.audioContext === ctx && this.gainNode) return ctx;
    this.audioContext = ctx;
    this.gainNode = ctx.createGain();
    this.contextManager.connectInput(this.gainNode);
    return ctx;
  }

  private requireGraph(): { context: AudioContext; gain: GainNode } {
    const context = this.attachGraph();
    return { context, gain: this.gainNode! };
  }

  private setPrebuffering(active: boolean): void {
    if (this.prebufferingNext === active) return;
    this.prebufferingNext = active;
    this.notifyStateChange();
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
        const { context } = this.requireGraph();
        const { decoderResult, audioBuffer: nativeBuffer } = await decodeAudioWithBuffer(
          arrayBuffer,
          context,
          undefined
        );
        if (controller.signal.aborted) return;

        if (nativeBuffer) {
          this.nextAudioBuffer = nativeBuffer;
        } else {
          const frameCount = decoderResult.interleavedBuffer.length / decoderResult.channels;
          const buffer = context.createBuffer(
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
      await ensureContextForBuffer(this.contextManager, arrayBuffer);
      const { context } = this.requireGraph();

      const { decoderResult, audioBuffer: nativeBuffer } = await decodeAudioWithBuffer(
        arrayBuffer,
        context,
        filename
      );

      await this.contextManager.ensureForTrack({
        sampleRate: decoderResult.sampleRate,
        channels: decoderResult.channels,
      });
      const { context: live } = this.requireGraph();

      if (nativeBuffer && live === context) {
        this.audioBuffer = nativeBuffer;
      } else {
        const frameCount = decoderResult.interleavedBuffer.length / decoderResult.channels;
        this.audioBuffer = live.createBuffer(
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

    const { context } = this.requireGraph();
    const when = context.currentTime + Math.max(0, remaining - (overlap > 0 ? overlap : 0));
    this._scheduleNextAt(when, overlap);
  }

  private _scheduleNextAt(when: number, overlap: number): void {
    if (!this.nextAudioBuffer || this.nextScheduled) return;
    this.nextScheduled = true;

    const { context, gain } = this.requireGraph();
    const nextSource = context.createBufferSource();
    nextSource.buffer = this.nextAudioBuffer;
    nextSource.playbackRate.value = this.playbackRate;

    if (overlap > 0) {
      if (!this.crossfadeGainNode) {
        this.crossfadeGainNode = context.createGain();
        this.contextManager.connectInput(this.crossfadeGainNode);
      }
      nextSource.connect(this.crossfadeGainNode);
      const end = when + overlap;
      gain.gain.setValueAtTime(gain.gain.value, when);
      gain.gain.linearRampToValueAtTime(0, end);
      this.crossfadeGainNode.gain.setValueAtTime(0, when);
      this.crossfadeGainNode.gain.linearRampToValueAtTime(1, end);
    } else {
      nextSource.connect(gain);
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
      const { context: live, gain } = this.requireGraph();
      this.startTime = live.currentTime;
      this.sourceNode = nextSource;
      if (this.crossfadeGainNode) {
        nextSource.disconnect();
        nextSource.connect(gain);
        this.crossfadeGainNode.disconnect();
        this.crossfadeGainNode = null;
        const now = live.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(1, now);
      }
      this.notifyStateChange();
      if (this.onEndedCallback) {
        try { this.onEndedCallback({ alreadyPlayingNext: true }); } catch (err) { console.warn('onEnded callback threw', err); }
      }
    }, Math.max(0, (swapAt - context.currentTime) * 1000));
  }

  play(): void {
    if (!this.audioBuffer) {
      console.error('No audio loaded');
      return;
    }

    if (this.isPlaying) {
      return;
    }

    const { context, gain } = this.requireGraph();

    if (context.state === 'suspended') {
      void this.contextManager.resume();
    }

    this.sourceNode = context.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(gain);
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
    this.startTime = context.currentTime - this.pausedAt / this.playbackRate;
    this.sourceNode.start(0, this.pausedAt);
    this.isPlaying = true;
    this.notifyStateChange();

    if (isGaplessActive(this.gaplessSettings) && this.nextAudioBuffer) {
      const overlap = overlapSeconds(this.gaplessSettings);
      const remaining = this.audioBuffer.duration - this.pausedAt;
      const when = context.currentTime + Math.max(0, remaining - (overlap > 0 ? overlap : GAPLESS_SCHEDULE_LEAD_S));
      this._scheduleNextAt(when, overlap);
    }
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode) {
      return;
    }

    this.rateAtPause = this.playbackRate;
    this.pausedAt = ((this.audioContext?.currentTime ?? 0) - this.startTime) * this.rateAtPause;

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
        (this.audioContext!.currentTime - this.startTime) * this.playbackRate,
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
      this.startTime = this.audioContext!.currentTime - currentPos / clampedRate;
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

  setReplayGainLinear(linear: number): void {
    this.contextManager.setReplayGainLinear(linear);
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.contextManager.setReplayGainLimiter(enabled);
  }

  getAnalyser(): AnalyserNode {
    return this.contextManager.getAnalyser();
  }

  getDecodedPcm(): DecodedPcmView | null {
    if (!this.audioBuffer) return null;
    return {
      pcm: this.audioBuffer.getChannelData(0),
      channels: 1,
      sampleRate: this.audioBuffer.sampleRate,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeGraph();
    this.clearPreload();
    this.stop();
    this.gainNode?.disconnect();
    this.gainNode = null;
    this.audioContext = null;
  }
}
