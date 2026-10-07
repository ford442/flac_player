import { EQChain, DEFAULT_EQ_BANDS } from './EQChain';
import {
  DSP_MAX_CHANNELS,
  DspChainNode,
  isDspWasmDisabledByUrl,
  isDspWasmSupported,
  type DspChainSettings,
} from './DspChainNode';
import { applyAnalyserPolicy } from './analyserPolicy';
import { ReplayGainNode } from './ReplayGainNode';
import {
  DEFAULT_AUDIO_CONTEXT_POLICY,
  chooseContextSampleRate,
  destinationChannelCount,
  latencyHintsEqual,
  latencyModeToHint,
  probeSampleRateSupported,
  relaxContextOptions,
  shouldRecreateContext,
  type AudioContextLatencyHint,
  type AudioContextOptionsWithSink,
  type AudioContextOptionsPolicy,
  type LatencyMode,
} from './sampleRatePolicy';

export interface EnsureTrackAudioOptions {
  sampleRate?: number;
  channels?: number;
}

/** Read-only snapshot of the live graph for Settings (hi-fi readout). */
export interface AudioOutputInfo {
  sampleRate: number;
  /** Seconds of processing latency inside the context (`AudioContext.baseLatency`). */
  baseLatency: number | null;
  /** Seconds from graph to the device (`AudioContext.outputLatency`). */
  outputLatency: number | null;
  latencyHint: AudioContextLatencyHint;
  channelCount: number;
  /** '' = system default output. */
  sinkId: string;
  state: AudioContextState;
  graphGeneration: number;
  /**
   * Who runs ReplayGain / limiter / volume / EQ for Web Audio backends:
   * 'wasm' = dsp_chain.h in the `dsp-chain` worklet (same code as SDL),
   * 'web-audio' = BiquadFilterNode / DynamicsCompressorNode fallback.
   */
  dspEngine: DspEngine;
}

export type DspEngine = 'wasm' | 'web-audio';

/** Longest ensureForTrack waits for the DSP worklet before playing through the fallback. */
const DSP_ATTACH_WAIT_MS = 1500;

type SinkAudioContext = AudioContext & {
  sinkId?: string | { type: string };
  setSinkId?: (sinkId: string) => Promise<void>;
};

/** True when `AudioContext.setSinkId` exists (Chromium 110+). */
export function isAudioContextSinkSupported(): boolean {
  const Ctor = globalThis.AudioContext as { prototype?: SinkAudioContext } | undefined;
  return typeof Ctor?.prototype?.setSinkId === 'function';
}

/**
 * Owns the application-lifetime Web Audio graph.
 *
 * Web Audio backends connect disposable source/input nodes via {@link connectInput};
 * the speaker DSP -> Analyser -> destination chain is rebuilt when sample rate or
 * latency hint changes. Speaker DSP is the `dsp-chain` worklet (dsp_chain.h in
 * WASM, identical to SDL) once it loads, else ReplayGain -> master Gain -> EQ
 * as Web Audio nodes.
 * SDL backends tap PCM into the analyser via {@link connectVisualizerFeed} while
 * {@link setExternalPlaybackActive} mutes Web Audio speakers (SDL owns output and
 * runs its own EQ / ReplayGain in WASM — see docs/AUDIO_BACKENDS.md).
 *
 * The context is created lazily at the track's native rate by {@link ensureForTrack}.
 * Setters (volume, EQ, ReplayGain, sink) only store state until a graph exists.
 * {@link getContext} is the one lazy creator: calling it before `ensureForTrack`
 * opens the device-default rate and the first track may recreate the graph.
 */
export class AudioContextManager {
  private context: AudioContext | null = null;
  private replayGain: ReplayGainNode | null = null;
  private masterGain: GainNode | null = null;
  private eqChain: EQChain | null = null;
  private analyser: AnalyserNode | null = null;
  private speakerGain: GainNode | null = null;
  /** Unity fan-in for backend sources; routed to the DSP worklet or the fallback chain. */
  private inputGain: GainNode | null = null;
  private dspChain: DspChainNode | null = null;
  private dspAttach: Promise<void> = Promise.resolve();
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
  private sinkId = '';
  /** Rates whose constructor threw; skipped so each track does not retry them. */
  private readonly rejectedSampleRates = new Set<number>();

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
      this.applyDestinationChannels();
    }
    const targetRate = chooseContextSampleRate(
      options.sampleRate,
      (rate) => !this.rejectedSampleRates.has(rate) && probeSampleRateSupported(rate)
    );
    const nextHint = this.policy.latencyHint;

    let context: AudioContext;
    if (!this.context) {
      context = this.buildGraph(targetRate);
    } else if (shouldRecreateContext({
      liveRate: this.context.sampleRate,
      targetRate,
      liveHint: this.appliedLatencyHint,
      nextHint,
      recreateOnMismatch: this.policy.recreateOnSampleRateMismatch,
    })) {
      context = await this.recreateGraph(targetRate ?? this.context.sampleRate);
    } else {
      context = this.context;
    }
    await this.waitForDspAttach();
    return context;
  }

  /**
   * Live context, creating one at the device default rate if none exists.
   * Call {@link ensureForTrack} first on playback paths to avoid a recreate.
   */
  getContext(): AudioContext {
    return this.initialize();
  }

  hasContext(): boolean {
    return this.context !== null;
  }

  getLastTrackChannels(): number | undefined {
    return this.lastTrackChannels;
  }

  /** Analyser of the live graph, or null before the first track opens one. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  connectInput(node: AudioNode): void {
    this.getContext();
    node.connect(this.inputGain!);
  }

  /** Which engine runs speaker DSP for Web Audio backends right now. */
  getDspEngine(): DspEngine {
    return this.dspChain ? 'wasm' : 'web-audio';
  }

  /** Feed SDL PCM tap worklet into the analyser (parallel to masterGain path). */
  connectVisualizerFeed(node: AudioNode): void {
    this.getContext();
    node.connect(this.visualizerFeedGain!);
  }

  getSinkId(): string {
    return this.sinkId;
  }

  /**
   * Route the graph to an output device ('' = system default). Applied live via
   * `AudioContext.setSinkId` and passed to future constructors. Resolves false
   * (and falls back to the default sink) when the device is rejected.
   */
  async setSinkId(sinkId: string): Promise<boolean> {
    this.sinkId = sinkId;
    const ctx = this.context as SinkAudioContext | null;
    if (!ctx || typeof ctx.setSinkId !== 'function') return true;
    if (this.currentContextSinkId(ctx) === sinkId) return true;
    try {
      await ctx.setSinkId(sinkId);
      return true;
    } catch (err) {
      console.warn('[AudioContextManager] setSinkId rejected; using default output', err);
      this.sinkId = '';
      try {
        await ctx.setSinkId('');
      } catch {
        /* already on default */
      }
      return false;
    }
  }

  getOutputInfo(): AudioOutputInfo | null {
    const ctx = this.context as SinkAudioContext | null;
    if (!ctx) return null;
    const finite = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      sampleRate: ctx.sampleRate,
      baseLatency: finite(ctx.baseLatency),
      outputLatency: finite(ctx.outputLatency),
      latencyHint: this.appliedLatencyHint,
      channelCount: ctx.destination.channelCount,
      sinkId: this.currentContextSinkId(ctx),
      state: ctx.state,
      graphGeneration: this.graphGeneration,
      dspEngine: this.getDspEngine(),
    };
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

  /** Resume a suspended graph. No-op before a graph exists (does not create one). */
  async resume(): Promise<void> {
    const context = this.context;
    if (context?.state === 'suspended') await context.resume();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.volume;
    }
    this.dspChain?.setVolume(this.volume);
  }

  getVolume(): number {
    return this.volume;
  }

  setReplayGainLinear(linear: number): void {
    this.replayGainLinear = Math.max(0, linear);
    this.replayGain?.setGainLinear(this.replayGainLinear);
    this.dspChain?.setReplayGain(this.replayGainLinear, this.limiterEnabled);
  }

  getReplayGainLinear(): number {
    return this.replayGainLinear;
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.limiterEnabled = enabled;
    this.replayGain?.setLimiterEnabled(enabled);
    this.dspChain?.setReplayGain(this.replayGainLinear, this.limiterEnabled);
  }

  setEQGains(gains: number[]): void {
    this.eqGains = DEFAULT_EQ_BANDS.map((_, i) => gains[i] ?? 0);
    this.eqChain?.setAllGains(this.eqGains);
    this.dspChain?.setEQGains(this.eqGains);
  }

  getEQGains(): number[] {
    return [...this.eqGains];
  }

  private buildGraph(sampleRate: number | undefined): AudioContext {
    const options: AudioContextOptionsWithSink = {
      latencyHint: this.policy.latencyHint,
    };
    if (sampleRate !== undefined) {
      options.sampleRate = sampleRate;
    }
    if (this.sinkId && isAudioContextSinkSupported()) {
      options.sinkId = this.sinkId;
    }

    const { context, options: applied } = this.constructContext(options);
    this.context = context;
    this.appliedLatencyHint = applied.latencyHint ?? this.policy.latencyHint;
    this.replayGain = new ReplayGainNode(this.context);
    this.masterGain = this.context.createGain();
    this.eqChain = new EQChain(this.context);
    this.analyser = this.context.createAnalyser();
    applyAnalyserPolicy(this.analyser);
    this.speakerGain = this.context.createGain();
    this.visualizerFeedGain = this.context.createGain();
    this.visualizerFeedGain.gain.value = 1;
    this.inputGain = this.context.createGain();

    this.inputGain.connect(this.replayGain.input);
    this.replayGain.output.connect(this.masterGain);
    this.masterGain.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.visualizerFeedGain.connect(this.analyser);
    this.analyser.connect(this.speakerGain);
    this.speakerGain.connect(this.context.destination);

    this.applyStoredGraphState();
    this.applyDestinationChannels();
    if (options.sinkId !== undefined && applied.sinkId === undefined) {
      // Constructor relaxation dropped the sink (e.g. it was the rate that failed); retry live.
      void this.setSinkId(this.sinkId);
    }
    this.dspAttach = this.attachDspChain(this.context);
    return this.context;
  }

  /** Graph width for the DSP worklet: the destination's channel count, 2..DSP_MAX_CHANNELS. */
  private dspChannelCount(ctx: AudioContext): number {
    const count = destinationChannelCount(this.lastTrackChannels, ctx.destination.maxChannelCount) ?? 2;
    return Math.max(2, Math.min(DSP_MAX_CHANNELS, count));
  }

  /**
   * Load the `dsp-chain` worklet and move the input off the fallback chain onto
   * it. Never rejects: on failure the BiquadFilterNode / compressor graph stays.
   */
  private async attachDspChain(ctx: AudioContext): Promise<void> {
    if (isDspWasmDisabledByUrl() || !isDspWasmSupported(ctx)) return;
    const channels = this.dspChannelCount(ctx);
    let dsp: DspChainNode;
    try {
      dsp = await DspChainNode.create(ctx, channels, this.dspSettings());
    } catch (err) {
      console.warn('[AudioContextManager] DSP WASM unavailable; using Web Audio EQ / ReplayGain', err);
      return;
    }
    if (this.context !== ctx || !this.inputGain || !this.analyser) {
      dsp.disconnect();
      return;
    }
    const previous = this.dspChain;
    this.dspChain = dsp;
    // Settings may have changed while the module loaded; resend (cheap, idempotent).
    const settings = this.dspSettings();
    dsp.setReplayGain(settings.replayGainLinear, settings.limiter);
    dsp.setVolume(settings.volume);
    dsp.setEQGains(settings.eqGains);
    dsp.node.connect(this.analyser);
    this.inputGain.disconnect();
    this.inputGain.connect(dsp.node);
    previous?.disconnect();
    if (dsp.channels !== this.dspChannelCount(ctx)) {
      // The track's channel count changed while loading; rebuild at the new width.
      this.dspAttach = this.attachDspChain(ctx);
    }
  }

  private dspSettings(): DspChainSettings {
    return {
      eqGains: this.eqGains,
      replayGainLinear: this.replayGainLinear,
      limiter: this.limiterEnabled,
      volume: this.volume,
    };
  }

  private async waitForDspAttach(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.dspAttach,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DSP_ATTACH_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Construct with progressively relaxed options (see {@link relaxContextOptions}).
   * A dropped numeric hint updates the policy; a dropped rate is remembered so
   * later tracks at that rate do not retry the failing constructor.
   */
  private constructContext(
    options: AudioContextOptionsWithSink
  ): { context: AudioContext; options: AudioContextOptionsWithSink } {
    let attempt = options;
    for (;;) {
      try {
        return { context: new AudioContext(attempt), options: attempt };
      } catch (err) {
        const next = relaxContextOptions(attempt);
        if (!next) throw err;
        console.warn('[AudioContextManager] AudioContext options rejected; retrying', {
          rejected: attempt,
          retry: next,
          err,
        });
        if (typeof attempt.latencyHint === 'number' && next.latencyHint !== attempt.latencyHint) {
          this.policy.latencyHint = next.latencyHint ?? 'interactive';
        }
        if (attempt.sampleRate !== undefined && next.sampleRate === undefined) {
          this.rejectedSampleRates.add(attempt.sampleRate);
        }
        attempt = next;
      }
    }
  }

  private currentContextSinkId(ctx: SinkAudioContext): string {
    return typeof ctx.sinkId === 'string' ? ctx.sinkId : '';
  }

  /** Match destination channels to the track (≥ stereo, ≤ device max). */
  private applyDestinationChannels(): void {
    const ctx = this.context;
    if (!ctx) return;
    const destination = ctx.destination;
    const count = destinationChannelCount(this.lastTrackChannels, destination.maxChannelCount);
    if (count !== undefined && destination.channelCount !== count) {
      try {
        destination.channelCount = count;
        destination.channelCountMode = 'explicit';
        destination.channelInterpretation = 'speakers';
      } catch (err) {
        console.warn('[AudioContextManager] destination.channelCount rejected', { count, err });
      }
    }
    // An attached DSP worklet has a fixed width; rebuild it when the track's differs.
    if (this.dspChain && this.dspChain.channels !== this.dspChannelCount(ctx)) {
      this.dspAttach = this.attachDspChain(ctx);
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
    this.dspChain?.disconnect();
    this.dspChain = null;
    this.inputGain = null;
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
