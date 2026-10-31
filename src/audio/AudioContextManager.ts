import { EQChain, DEFAULT_EQ_BANDS } from './EQChain';
import {
  DSP_MAX_CHANNELS,
  DspChainNode,
  isDspWasmDisabledByUrl,
  isDspWasmSupported,
  type DspChainSettings,
} from './DspChainNode';
import { applyAnalyserPolicy } from './analyserPolicy';
import { setAnalysisTap } from './analysisRing';
import { ReplayGainNode } from './ReplayGainNode';
import {
  DEFAULT_AUDIO_CONTEXT_POLICY,
  chooseContextSampleRate,
  destinationChannelCount,
  latencyHintsEqual,
  latencyModeToHint,
  isRenderSizeHintSupported,
  isNativeRateRequestedByUrl,
  isSampleRateAccepted,
  relaxContextOptions,
  renderSizeModeToHint,
  shouldRecreateContext,
  type AudioContextLatencyHint,
  type AudioContextOptionsWithSink,
  type AudioContextOptionsPolicy,
  type LatencyMode,
  type RenderSizeHint,
  type RenderSizeMode,
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
  /** renderSizeHint the live context was built with (undefined = omitted / relaxed away). */
  renderSizeHint: RenderSizeHint | undefined;
  /** `AudioContext.renderQuantumSize` when exposed (frames per callback), else null. */
  renderQuantumSize: number | null;
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

/**
 * Lifecycle of the shared context as the rest of the app sees it. `interrupted`
 * is WebKit's state while a call / Siri holds the audio session; `none` is
 * before the first graph.
 */
export type AudioGraphState = 'none' | 'running' | 'suspended' | 'interrupted' | 'closed';

/** Paused this long, the context is suspended (stops rendering EQ / analyser, releases the iOS session). */
export const IDLE_SUSPEND_MS = 10_000;

/** Chromium's "render, but play nowhere" sink for external playback integrations. */
const SILENT_SINK = { type: 'none' } as const;
type SinkTarget = string | typeof SILENT_SINK;

/** Longest ensureForTrack waits for the DSP worklet before playing through the fallback. */
const DSP_ATTACH_WAIT_MS = 1500;

type SinkAudioContext = AudioContext & {
  sinkId?: string | { type: string };
  setSinkId?: (sinkId: SinkTarget) => Promise<void>;
};

/** Safari's Audio Session API (16.4+). */
type NavigatorWithAudioSession = Navigator & { audioSession?: { type: string } };

/** Events that count as a user activation for `resume()` on WebKit / Chromium. */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;

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
 * External playback integrations can tap PCM into the analyser via
 * {@link connectVisualizerFeed} while {@link setExternalPlaybackActive} mutes Web Audio speakers.
 *
 * The context is created lazily at the device rate by {@link ensureForTrack} (or
 * {@link unlock}, inside a user gesture) and kept for the page's lifetime; latency,
 * render-size or (opt-in) file-rate changes rebuild it. Setters (volume, EQ,
 * ReplayGain, sink) only store state until a graph exists.
 *
 * Lifecycle: {@link getState} / {@link subscribeState} follow the context's
 * `statechange`. The owner reports whether playback is wanted via
 * {@link setPlaybackActive}; while it is, a suspended or interrupted context is
 * resumed on the next gesture or when the page becomes visible, and while it is
 * not, the context is suspended after {@link IDLE_SUSPEND_MS}.
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
  private appliedRenderSizeHint: RenderSizeHint | undefined = undefined;
  /** Set when the constructor rejected renderSizeHint; not retried until the mode changes. */
  private renderSizeHintRejected = false;
  private graphGeneration = 0;
  private readonly graphListeners = new Set<() => void>();
  private lastTrackChannels: number | undefined;
  private sinkId = '';
  /** Rates whose constructor threw; skipped so each track does not retry them. */
  private readonly rejectedSampleRates = new Set<number>();
  private readonly stateListeners = new Set<(state: AudioGraphState) => void>();
  private lastState: AudioGraphState = 'none';
  /** Something is playing or about to (the engine's transport, not the context's state). */
  private playbackActive = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleInstalled = false;

  constructor(private readonly idleSuspendMs = IDLE_SUSPEND_MS) {
    if (isNativeRateRequestedByUrl()) this.policy.recreateOnSampleRateMismatch = true;
  }

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
   * Render quantum hint. Ignored (omitted) where the browser has no
   * `renderQuantumSize`; a rejected value is relaxed away at construct time.
   */
  async setRenderSizeMode(mode: RenderSizeMode): Promise<void> {
    const hint = renderSizeModeToHint(mode);
    if (hint === this.policy.renderSizeHint) return;
    this.policy.renderSizeHint = hint;
    this.renderSizeHintRejected = false;
    if (!this.context) return;
    if (this.requestedRenderSizeHint() === this.appliedRenderSizeHint) return;
    await this.recreateGraph(this.context.sampleRate);
  }

  private requestedRenderSizeHint(): RenderSizeHint | undefined {
    if (this.renderSizeHintRejected || !isRenderSizeHintSupported()) return undefined;
    return this.policy.renderSizeHint;
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
    // Device rate unless the (opt-in) native-rate policy asks for the file's.
    const targetRate = this.policy.recreateOnSampleRateMismatch
      ? chooseContextSampleRate(
        options.sampleRate,
        (rate) => !this.rejectedSampleRates.has(rate) && isSampleRateAccepted(rate)
      )
      : this.policy.sampleRate;
    const nextHint = this.policy.latencyHint;

    let context: AudioContext;
    if (!this.context) {
      context = this.buildGraph(targetRate);
    } else if (shouldRecreateContext({
      liveRate: this.context.sampleRate,
      targetRate,
      liveHint: this.appliedLatencyHint,
      nextHint,
      liveRenderSize: this.appliedRenderSizeHint,
      nextRenderSize: this.requestedRenderSizeHint(),
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
    // External playback owns the speakers; apply the stored id when it hands them back.
    if (this.externalPlaybackActive) return true;
    if (this.currentContextSinkId(ctx) === sinkId && !isSilentSink(ctx.sinkId)) return true;
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
      renderSizeHint: this.appliedRenderSizeHint,
      renderQuantumSize: finite((ctx as { renderQuantumSize?: unknown }).renderQuantumSize),
      channelCount: ctx.destination.channelCount,
      sinkId: this.currentContextSinkId(ctx),
      state: ctx.state,
      graphGeneration: this.graphGeneration,
      dspEngine: this.getDspEngine(),
    };
  }

  /**
   * Mute Web Audio speakers while an external playback integration owns output.
   * Where supported the context also moves to a `{ type: 'none' }` sink so it
   * renders for the analyser without holding a real output device open.
   */
  setExternalPlaybackActive(active: boolean): void {
    if (active === this.externalPlaybackActive) return;
    this.externalPlaybackActive = active;
    if (this.speakerGain) {
      this.speakerGain.gain.value = active ? 0 : 1;
    }
    const ctx = this.context as SinkAudioContext | null;
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    const target: SinkTarget = active ? SILENT_SINK : this.sinkId;
    ctx.setSinkId(target).catch((err) => {
      console.warn('[AudioContextManager] setSinkId failed', { target, err });
    });
  }

  isExternalPlaybackActive(): boolean {
    return this.externalPlaybackActive;
  }

  /**
   * Resume a suspended or interrupted graph. No-op before a graph exists (does
   * not create one). Never rejects: outside a user gesture the browser may refuse,
   * and the gesture listener ({@link installLifecycle}) retries.
   */
  async resume(): Promise<void> {
    this.cancelIdleSuspend();
    const context = this.context;
    if (!context || !isResumable(context.state)) return;
    try {
      await context.resume();
    } catch (err) {
      console.warn('[AudioContextManager] resume() refused; waiting for a user gesture', err);
    }
  }

  /**
   * Call synchronously inside a user gesture (play / track click): creates the
   * graph if there is none and resumes it, so WebKit starts it `running` instead
   * of after the awaited network probe, outside the gesture.
   */
  unlock(): void {
    this.installLifecycle();
    if (!this.context) this.initialize();
    void this.resume();
  }

  getState(): AudioGraphState {
    return this.lastState;
  }

  subscribeState(listener: (state: AudioGraphState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Whether the app wants sound (transport playing or loading). Active resumes
   * now; inactive suspends the context after {@link IDLE_SUSPEND_MS} so paused
   * playback stops rendering and releases the OS audio session.
   */
  setPlaybackActive(active: boolean): void {
    this.playbackActive = active;
    if (active) {
      void this.resume();
      return;
    }
    this.cancelIdleSuspend();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const ctx = this.context;
      if (this.playbackActive || !ctx || ctx.state !== 'running') return;
      ctx.suspend().catch(() => { /* closed meanwhile */ });
    }, this.idleSuspendMs);
  }

  isPlaybackActive(): boolean {
    return this.playbackActive;
  }

  /**
   * Install the page-level listeners once: gesture unlock (resume while playback
   * is wanted), `visibilitychange` (resume on return), and
   * `navigator.audioSession.type = 'playback'` (Safari: plays with the ringer
   * switch off, ducks for calls like a media app). Safe to call repeatedly.
   */
  installLifecycle(): void {
    if (this.lifecycleInstalled || typeof window === 'undefined') return;
    this.lifecycleInstalled = true;
    const session = (navigator as NavigatorWithAudioSession).audioSession;
    if (session) {
      try {
        session.type = 'playback';
      } catch {
        /* read-only in this engine */
      }
    }
    const onGesture = () => {
      if (this.playbackActive && this.context && isResumable(this.context.state)) void this.resume();
    };
    for (const type of GESTURE_EVENTS) {
      window.addEventListener(type, onGesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onGesture();
    });
  }

  private cancelIdleSuspend(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private watchContext(ctx: AudioContext): void {
    ctx.addEventListener?.('statechange', () => {
      if (ctx !== this.context) return;
      this.publishState();
      // An interruption ended (iOS returns to 'suspended') or the OS suspended us: retry.
      if (this.playbackActive && isResumable(ctx.state)) void this.resume();
    });
    // Chromium: the sink went away (device unplugged) — fall back to the system default.
    ctx.addEventListener?.('error', (event) => {
      if (ctx !== this.context) return;
      console.warn('[AudioContextManager] output device error; using the system default', event);
      if (this.sinkId) void this.setSinkId('');
    });
    ctx.addEventListener?.('sinkchange', () => {
      if (ctx === this.context) this.notifyGraphListeners();
    });
    this.publishState();
  }

  private publishState(): void {
    const state = (this.context?.state as AudioGraphState | undefined) ?? 'none';
    if (state === this.lastState) return;
    this.lastState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.warn('[AudioContextManager] state listener threw', err);
      }
    }
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
    if (isAudioContextSinkSupported()) {
      if (this.externalPlaybackActive) options.sinkId = SILENT_SINK;
      else if (this.sinkId) options.sinkId = this.sinkId;
    }
    const renderSizeHint = this.requestedRenderSizeHint();
    if (renderSizeHint !== undefined) {
      options.renderSizeHint = renderSizeHint;
    }

    const { context, options: applied } = this.constructContext(options);
    this.context = context;
    this.watchContext(context);
    this.appliedLatencyHint = applied.latencyHint ?? this.policy.latencyHint;
    this.appliedRenderSizeHint = applied.renderSizeHint;
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
    if (options.sinkId !== undefined && applied.sinkId === undefined && !this.externalPlaybackActive) {
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
    setAnalysisTap('dsp-chain', dsp.analysisRing);
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
        if (attempt.renderSizeHint !== undefined && next.renderSizeHint === undefined) {
          this.renderSizeHintRejected = true;
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
    if (count !== undefined) this.replayGain?.setChannelCount(count);
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
    this.replayGain?.disconnect();
    this.eqChain?.disconnect();
    this.dspChain?.disconnect();
    this.dspChain = null;
    setAnalysisTap('dsp-chain', null);
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
    if (!this.playbackActive) this.setPlaybackActive(false); // re-arm the idle suspend for the new context
    if (previous && previous.state !== 'closed') {
      try {
        await previous.close();
      } catch {
        /* already closed */
      }
    }
    this.notifyGraphListeners();
    return next;
  }

  private notifyGraphListeners(): void {
    for (const listener of this.graphListeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[AudioContextManager] graph listener threw', err);
      }
    }
  }
}

function isResumable(state: AudioContextState | 'interrupted'): boolean {
  return state === 'suspended' || state === 'interrupted';
}

function isSilentSink(sinkId: unknown): boolean {
  return typeof sinkId === 'object' && sinkId !== null && (sinkId as { type?: unknown }).type === 'none';
}

export const sharedAudioContextManager = new AudioContextManager();
