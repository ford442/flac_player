import { EQChain } from './EQChain';

export interface AudioContextConfig {
  /**
   * Desired render rate. Omit to use the device native rate, which avoids the
   * double resample you get when the context rate differs from the hardware.
   */
  sampleRate?: number;
  latencyHint: NonNullable<AudioContextOptions['latencyHint']>;
}

/** Rates worth requesting; anything else falls back to device native. */
const SUPPORTED_SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

/**
 * Owns the application-lifetime Web Audio graph.
 *
 * Web Audio backends connect disposable source/input nodes to `input`; the
 * master Gain -> EQ -> Analyser -> destination chain is connected exactly once.
 * SDL backends tap PCM into the analyser via {@link connectVisualizerFeed} while
 * {@link setExternalPlaybackActive} mutes Web Audio speakers (SDL owns output).
 *
 * The context is created lazily, on first use, so construction can pick up a
 * track's sample rate if one is known by then. `sampleRate` and `latencyHint`
 * are construction-time only, so changing either means building a new context:
 * see {@link configure}, which notifies subscribers so backends can rebuild
 * their nodes (nodes from a closed context cannot be reconnected).
 */
export class AudioContextManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private eqChain: EQChain | null = null;
  private analyser: AnalyserNode | null = null;
  private speakerGain: GainNode | null = null;
  private visualizerFeedGain: GainNode | null = null;
  private externalPlaybackActive = false;

  private config: AudioContextConfig = { latencyHint: 'playback' };
  private listeners = new Set<() => void>();
  private lastVolume = 1;
  private lastEQGains: number[] | null = null;

  initialize(): AudioContext {
    if (this.context) return this.context;

    // Omitting sampleRate yields the device native rate. Requesting an
    // unsupported rate throws, so fall back rather than break playback.
    const options: AudioContextOptions = { latencyHint: this.config.latencyHint };
    if (this.config.sampleRate && SUPPORTED_SAMPLE_RATES.includes(this.config.sampleRate)) {
      options.sampleRate = this.config.sampleRate;
    }

    try {
      this.context = new AudioContext(options);
    } catch (err) {
      console.warn('[AudioContextManager] Falling back to device default rate:', err);
      this.context = new AudioContext({ latencyHint: this.config.latencyHint });
    }

    this.buildGraph(this.context);
    return this.context;
  }

  private buildGraph(context: AudioContext): void {
    this.masterGain = context.createGain();
    this.eqChain = new EQChain(context);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.speakerGain = context.createGain();
    this.visualizerFeedGain = context.createGain();
    this.visualizerFeedGain.gain.value = 1;

    this.masterGain.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.visualizerFeedGain.connect(this.analyser);
    this.analyser.connect(this.speakerGain);
    this.speakerGain.connect(context.destination);

    // Carry user settings across a rebuild.
    this.masterGain.gain.value = this.lastVolume;
    this.speakerGain.gain.value = this.externalPlaybackActive ? 0 : 1;
    if (this.lastEQGains) this.eqChain.setAllGains(this.lastEQGains);
  }

  /**
   * Apply construction-time options. Rebuilds the context (and notifies
   * subscribers) only when a value actually differs from the live context.
   *
   * Returns true when a rebuild happened — playback is interrupted in that
   * case, since every source node belonged to the old context.
   */
  configure(next: Partial<AudioContextConfig>): boolean {
    const merged: AudioContextConfig = { ...this.config, ...next };

    const latencyChanged = merged.latencyHint !== this.config.latencyHint;
    // Compare against the context's real rate: a request for 96000 that the
    // device rejected must not trigger a rebuild on every subsequent track.
    const rateChanged = merged.sampleRate !== undefined
      && this.context !== null
      && this.isRateWorthSwitching(merged.sampleRate);

    this.config = merged;

    if (!this.context) return false;            // picked up at lazy creation
    if (!latencyChanged && !rateChanged) return false;

    this.rebuild();
    return true;
  }

  private isRateWorthSwitching(rate: number): boolean {
    if (!this.context) return false;
    if (!SUPPORTED_SAMPLE_RATES.includes(rate)) return false;
    return this.context.sampleRate !== rate;
  }

  private rebuild(): void {
    const old = this.context;
    this.context = null;
    this.masterGain = null;
    this.eqChain = null;
    this.analyser = null;
    this.speakerGain = null;
    this.visualizerFeedGain = null;

    void old?.close().catch(() => { /* already closed */ });

    this.initialize();
    this.listeners.forEach(listener => {
      try {
        listener();
      } catch (err) {
        console.error('[AudioContextManager] context change listener threw:', err);
      }
    });
  }

  /** Subscribe to context rebuilds. Returns an unsubscribe function. */
  onContextChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The rate the graph actually renders at — use this for position math. */
  getSampleRate(): number {
    return this.initialize().sampleRate;
  }

  getContext(): AudioContext {
    return this.initialize();
  }

  getAnalyser(): AnalyserNode {
    this.initialize();
    return this.analyser!;
  }

  connectInput(node: AudioNode): void {
    this.initialize();
    node.connect(this.masterGain!);
  }

  /** Feed SDL PCM tap worklet into the analyser (parallel to masterGain path). */
  connectVisualizerFeed(node: AudioNode): void {
    this.initialize();
    node.connect(this.visualizerFeedGain!);
  }

  /** Mute Web Audio speakers when SDL owns playback; analyser still receives PCM. */
  setExternalPlaybackActive(active: boolean): void {
    this.initialize();
    this.externalPlaybackActive = active;
    this.speakerGain!.gain.value = active ? 0 : 1;
  }

  isExternalPlaybackActive(): boolean {
    return this.externalPlaybackActive;
  }

  async resume(): Promise<void> {
    const context = this.initialize();
    if (context.state === 'suspended') await context.resume();
  }

  setVolume(volume: number): void {
    this.initialize();
    this.lastVolume = Math.max(0, Math.min(1, volume));
    this.masterGain!.gain.value = this.lastVolume;
  }

  setEQGains(gains: number[]): void {
    this.initialize();
    this.lastEQGains = [...gains];
    this.eqChain!.setAllGains(gains);
  }

  getEQGains(): number[] {
    this.initialize();
    return this.eqChain!.getAllGains();
  }
}

export const sharedAudioContextManager = new AudioContextManager();
