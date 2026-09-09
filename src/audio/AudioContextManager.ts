import { EQChain, DEFAULT_EQ_BANDS } from './EQChain';
import { ReplayGainNode } from './ReplayGainNode';
import {
  DEFAULT_AUDIO_CONTEXT_POLICY,
  chooseContextSampleRate,
  latencyHintsEqual,
  latencyModeToHint,
  probeSampleRateSupported,
  shouldRecreateContext,
  type AudioContextLatencyHint,
  type AudioContextOptionsPolicy,
  type LatencyMode,
} from './sampleRatePolicy';

export interface EnsureTrackAudioOptions {
  sampleRate?: number;
  channels?: number;
}

/**
 * Owns the application-lifetime Web Audio graph.
 *
 * Web Audio backends connect disposable source/input nodes to `input`; the
 * ReplayGain -> master Gain -> EQ -> Analyser -> destination chain is rebuilt
 * when sample rate or latency hint changes.
 * SDL backends tap PCM into the analyser via {@link connectVisualizerFeed} while
 * {@link setExternalPlaybackActive} mutes Web Audio speakers (SDL owns output).
 */
export class AudioContextManager {
  private context: AudioContext | null = null;
  private replayGain: ReplayGainNode | null = null;
  private masterGain: GainNode | null = null;
  private eqChain: EQChain | null = null;
  private analyser: AnalyserNode | null = null;
  private speakerGain: GainNode | null = null;
  private visualizerFeedGain: GainNode | null = null;
  private externalPlaybackActive = false;
  private replayGainLinear = 1;
  private limiterEnabled = false;
  private volume = 1;
  private eqGains: number[] = DEFAULT_EQ_BANDS.map(() => 0);
  private policy: AudioContextOptionsPolicy = { ...DEFAULT_AUDIO_CONTEXT_POLICY };
  private appliedLatencyHint: AudioContextLatencyHint = this.policy.latencyHint;
  private graphGeneration = 0;
  private readonly graphListeners = new Set<() => void>();
  private lastTrackChannels: number | undefined;

  subscribeGraphRecreated(listener: () => void): () => void {
    this.graphListeners.add(listener);
    return () => {
      this.graphListeners.delete(listener);
    };
  }

  getGraphGeneration(): number {
    return this.graphGeneration;
  }

  getPolicy(): AudioContextOptionsPolicy {
    return { ...this.policy };
  }

  setPolicy(partial: Partial<AudioContextOptionsPolicy>): void {
    this.policy = { ...this.policy, ...partial };
  }

  async setLatencyMode(mode: LatencyMode): Promise<void> {
    const hint = latencyModeToHint(mode);
    this.policy.latencyHint = hint;
    if (!this.context) return;
    if (latencyHintsEqual(this.appliedLatencyHint, hint)) return;
    await this.recreateGraph(this.context.sampleRate);
  }

  /**
   * Create the graph at the device default rate and current latency hint.
   * Does not lock 44.1 kHz. Prefer {@link ensureForTrack} before playback.
   */
  initialize(): AudioContext {
    if (this.context) return this.context;
    return this.buildGraph(undefined);
  }

  async ensureForTrack(options: EnsureTrackAudioOptions = {}): Promise<AudioContext> {
    if (options.channels && options.channels > 0) {
      this.lastTrackChannels = options.channels;
    }
    const targetRate = chooseContextSampleRate(options.sampleRate, probeSampleRateSupported);
    const nextHint = this.policy.latencyHint;

    if (!this.context) {
      return this.buildGraph(targetRate);
    }

    if (shouldRecreateContext({
      liveRate: this.context.sampleRate,
      targetRate,
      liveHint: this.appliedLatencyHint,
      nextHint,
      recreateOnMismatch: this.policy.recreateOnSampleRateMismatch,
    })) {
      return this.recreateGraph(targetRate ?? this.context.sampleRate);
    }

    return this.context;
  }

  getContext(): AudioContext {
    return this.initialize();
  }

  hasContext(): boolean {
    return this.context !== null;
  }

  getLastTrackChannels(): number | undefined {
    return this.lastTrackChannels;
  }

  getAnalyser(): AnalyserNode {
    this.initialize();
    return this.analyser!;
  }

  connectInput(node: AudioNode): void {
    this.initialize();
    node.connect(this.replayGain!.input);
  }

  /** Feed SDL PCM tap worklet into the analyser (parallel to masterGain path). */
  connectVisualizerFeed(node: AudioNode): void {
    this.initialize();
    node.connect(this.visualizerFeedGain!);
  }

  /** Mute Web Audio speakers when SDL owns playback; analyser still receives PCM. */
  setExternalPlaybackActive(active: boolean): void {
    this.externalPlaybackActive = active;
    if (this.speakerGain) {
      this.speakerGain.gain.value = active ? 0 : 1;
    }
  }

  isExternalPlaybackActive(): boolean {
    return this.externalPlaybackActive;
  }

  async resume(): Promise<void> {
    const context = this.initialize();
    if (context.state === 'suspended') await context.resume();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.volume;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setReplayGainLinear(linear: number): void {
    this.replayGainLinear = Math.max(0, linear);
    if (!this.replayGain) this.initialize();
    this.replayGain!.setGainLinear(this.replayGainLinear);
  }

  getReplayGainLinear(): number {
    return this.replayGainLinear;
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.limiterEnabled = enabled;
    if (!this.replayGain) this.initialize();
    this.replayGain!.setLimiterEnabled(enabled);
  }

  setEQGains(gains: number[]): void {
    this.eqGains = DEFAULT_EQ_BANDS.map((_, i) => gains[i] ?? 0);
    if (!this.eqChain) this.initialize();
    this.eqChain!.setAllGains(this.eqGains);
  }

  getEQGains(): number[] {
    return [...this.eqGains];
  }

  private buildGraph(sampleRate: number | undefined): AudioContext {
    const options: AudioContextOptions = {
      latencyHint: this.policy.latencyHint,
    };
    if (sampleRate !== undefined) {
      options.sampleRate = sampleRate;
    }

    this.context = this.constructContext(options);
    this.appliedLatencyHint = options.latencyHint ?? this.policy.latencyHint;
    this.replayGain = new ReplayGainNode(this.context);
    this.masterGain = this.context.createGain();
    this.eqChain = new EQChain(this.context);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.speakerGain = this.context.createGain();
    this.visualizerFeedGain = this.context.createGain();
    this.visualizerFeedGain.gain.value = 1;

    this.replayGain.output.connect(this.masterGain);
    this.masterGain.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.visualizerFeedGain.connect(this.analyser);
    this.analyser.connect(this.speakerGain);
    this.speakerGain.connect(this.context.destination);

    this.applyStoredGraphState();
    return this.context;
  }

  private constructContext(options: AudioContextOptions): AudioContext {
    try {
      return new AudioContext(options);
    } catch (err) {
      if (typeof options.latencyHint === 'number') {
        const fallback: AudioContextOptions = { ...options, latencyHint: 'interactive' };
        this.policy.latencyHint = 'interactive';
        return new AudioContext(fallback);
      }
      throw err;
    }
  }

  private applyStoredGraphState(): void {
    if (this.masterGain) this.masterGain.gain.value = this.volume;
    if (this.replayGain) {
      this.replayGain.setGainLinear(this.replayGainLinear);
      this.replayGain.setLimiterEnabled(this.limiterEnabled);
    }
    if (this.eqChain) this.eqChain.setAllGains(this.eqGains);
    if (this.speakerGain) {
      this.speakerGain.gain.value = this.externalPlaybackActive ? 0 : 1;
    }
  }

  private async recreateGraph(sampleRate: number | undefined): Promise<AudioContext> {
    const previous = this.context;
    this.eqChain?.disconnect();
    this.context = null;
    this.replayGain = null;
    this.masterGain = null;
    this.eqChain = null;
    this.analyser = null;
    this.speakerGain = null;
    this.visualizerFeedGain = null;

    const next = this.buildGraph(sampleRate);
    this.graphGeneration += 1;
    if (previous && previous.state !== 'closed') {
      try {
        await previous.close();
      } catch {
        /* already closed */
      }
    }
    for (const listener of this.graphListeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[AudioContextManager] graph listener threw', err);
      }
    }
    return next;
  }
}

export const sharedAudioContextManager = new AudioContextManager();
